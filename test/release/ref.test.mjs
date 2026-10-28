import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = join(root, "scripts/release-artifact.mjs");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = manifest.version;
const tag = `v${version}`;
const prerelease = version.includes("-");
const distTag = prerelease ? "next" : "latest";
const commit = "1".repeat(40);
const otherCommit = "2".repeat(40);

const fakeGitSource = `#!/usr/bin/env node
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.INBOX_RELEASE_REF_FIXTURE, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(config.log, JSON.stringify(args) + "\\n");
if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
  process.stdout.write(config.head + "\\n");
} else if (args.length === 2 && args[0] === "rev-parse" && args[1] === "refs/tags/" + config.tag + "^{commit}") {
  process.stdout.write(config.tagCommit + "\\n");
} else if (JSON.stringify(args) === JSON.stringify(["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"])) {
  if (config.fetchFailure) {
    process.stderr.write("fixture origin unavailable\\n");
    process.exit(1);
  }
} else if (JSON.stringify(args) === JSON.stringify(["merge-base", "--is-ancestor", config.head, "refs/remotes/origin/main"])) {
  if (config.ancestryFailure) process.exit(1);
} else {
  process.stderr.write("Unexpected git invocation: " + JSON.stringify(args) + "\\n");
  process.exit(91);
}
`;

async function executeRef(
  t,
  { env = {}, event = {}, release = {}, git = {} } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "inbox-release-ref-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const gitExecutable = join(bin, "git");
  await writeFile(gitExecutable, fakeGitSource);
  await chmod(gitExecutable, 0o755);
  const gitLog = join(directory, "git.jsonl");
  const configPath = join(directory, "git-fixture.json");
  await writeFile(
    configPath,
    JSON.stringify({
      head: commit,
      tagCommit: commit,
      tag,
      log: gitLog,
      ...git,
    }),
  );
  const eventPath = join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "published",
      ...event,
      release: { tag_name: tag, draft: false, prerelease, ...release },
    }),
  );
  const outputPath = join(directory, "github-output");
  await writeFile(outputPath, "");

  const result = spawnSync(process.execPath, [helper, "ref"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(
        delimiter,
      ),
      INBOX_RELEASE_REF_FIXTURE: configPath,
      GITHUB_REPOSITORY: "nestarc/inbox",
      GITHUB_SHA: commit,
      GITHUB_EVENT_NAME: "release",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_OUTPUT: outputPath,
      ...env,
    },
  });
  assert.ifError(result.error);
  assert.equal(
    result.signal,
    null,
    "Release helper must terminate without a signal",
  );
  const output = await readFile(outputPath, "utf8");
  const log = await readFile(gitLog, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return {
    ...result,
    output,
    calls: log.trim() ? log.trim().split("\n").map(JSON.parse) : [],
  };
}

function rejected(result, message) {
  assert.notEqual(result.status, 0, "Invalid release must fail the CLI");
  assert.equal(
    result.output,
    "",
    "A failed gate must not emit publish outputs",
  );
  if (message) assert.match(result.stderr, message);
}

describe("release source and event gate", () => {
  it("accepts a published release only after checking the tag commit and refreshed main ancestry", async (t) => {
    const result = await executeRef(t);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.output,
      `version=${version}\ndist-tag=${distTag}\nprerelease=${prerelease}\n`,
    );
    assert.match(result.stdout, new RegExp(`npm channel ${distTag}`));
    assert.deepEqual(result.calls, [
      ["rev-parse", "HEAD"],
      ["rev-parse", `refs/tags/${tag}^{commit}`],
      ["fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"],
      ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
    ]);
  });

  it("allows workflow_dispatch as a validation gate without requiring or fetching a release tag", async (t) => {
    const result = await executeRef(t, {
      env: {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      },
      git: {
        fetchFailure: true,
        ancestryFailure: true,
        tagCommit: otherCommit,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.output,
      `version=${version}\ndist-tag=${distTag}\nprerelease=${prerelease}\n`,
    );
    assert.deepEqual(result.calls, [["rev-parse", "HEAD"]]);
  });

  it("rejects a release tag or GitHub ref that disagrees with package.json", async (t) => {
    const wrongTag = await executeRef(t, { release: { tag_name: "v9.9.9" } });
    rejected(wrongTag, /tag must match package version/i);
    assert.deepEqual(wrongTag.calls, [["rev-parse", "HEAD"]]);
    const wrongRef = await executeRef(t, {
      env: { GITHUB_REF: "refs/tags/v9.9.9" },
    });
    rejected(wrongRef);
    assert.deepEqual(wrongRef.calls, [["rev-parse", "HEAD"]]);
  });

  it("rejects a prerelease flag that would choose the wrong npm channel", async (t) => {
    const result = await executeRef(t, {
      release: { prerelease: !prerelease },
    });
    rejected(result, /prerelease flag must match the version/i);
    assert.deepEqual(result.calls, [["rev-parse", "HEAD"]]);
  });

  it("rejects draft releases and release actions other than published", async (t) => {
    rejected(await executeRef(t, { release: { draft: true } }));
    for (const action of ["created", "edited", "deleted", "unpublished"]) {
      const result = await executeRef(t, { event: { action } });
      rejected(result);
      assert.deepEqual(result.calls, [["rev-parse", "HEAD"]]);
    }
  });

  it("rejects a tag moved to a different commit before fetching main", async (t) => {
    const result = await executeRef(t, { git: { tagCommit: otherCommit } });
    rejected(result, /Tag moved or points to a different commit/);
    assert.deepEqual(result.calls, [
      ["rev-parse", "HEAD"],
      ["rev-parse", `refs/tags/${tag}^{commit}`],
    ]);
  });

  it("rejects another repository or a checkout that differs from the event SHA", async (t) => {
    const fork = await executeRef(t, {
      env: { GITHUB_REPOSITORY: "other/inbox" },
    });
    rejected(fork, /Release must run in nestarc\/inbox/);
    const changed = await executeRef(t, { git: { head: otherCommit } });
    rejected(changed, /Checked-out commit differs from event/);
    assert.deepEqual(changed.calls, [["rev-parse", "HEAD"]]);
  });

  it("fails closed when the remote main refresh fails", async (t) => {
    const result = await executeRef(t, { git: { fetchFailure: true } });
    rejected(result, /fixture origin unavailable/);
    assert.equal(result.calls.at(-1)[0], "fetch");
    assert.equal(
      result.calls.some((args) => args[0] === "merge-base"),
      false,
    );
  });

  it("rejects a release commit that is not an ancestor of the refreshed main", async (t) => {
    const result = await executeRef(t, { git: { ancestryFailure: true } });
    rejected(result, /merge-base --is-ancestor/);
    assert.deepEqual(result.calls.at(-1), [
      "merge-base",
      "--is-ancestor",
      commit,
      "refs/remotes/origin/main",
    ]);
  });

  it("rejects unsolicited workflow event types", async (t) => {
    for (const name of [
      "push",
      "pull_request",
      "pull_request_target",
      "schedule",
    ]) {
      const result = await executeRef(t, { env: { GITHUB_EVENT_NAME: name } });
      rejected(result, /Unsupported release event/);
      assert.deepEqual(result.calls, [["rev-parse", "HEAD"]]);
    }
  });
});
