import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const commit = "a".repeat(40);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

async function fixture(t, { version = rootManifest.version } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "inbox-candidate-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staging = join(directory, "staging");
  const files = {
    "package.json": JSON.stringify({ ...rootManifest, version }),
    "dist/index.js": "module.exports = {};\n",
    "dist/index.d.ts": "export {};\n",
    "dist/testing/index.js": "module.exports = {};\n",
    "dist/testing/index.d.ts": "export {};\n",
    "src/sql/create-inbox-table.sql": "-- candidate schema\n",
    "src/sql/migrate-v1-to-v2.sql": "-- candidate migration\n",
    "examples/package.json": JSON.stringify({
      name: "candidate-examples",
      private: true,
    }),
  };
  for (const [path, value] of Object.entries(files)) {
    const destination = join(staging, "package", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, value);
  }
  const tarball = join(directory, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", staging, "package"], {
    stdio: "pipe",
  });
  const bytes = await readFile(tarball);
  const metadata = join(directory, "metadata.json");
  await writeFile(
    metadata,
    JSON.stringify({
      schemaVersion: 1,
      name: "@nestarc/inbox",
      version,
      filename: "package.tgz",
      size: bytes.length,
      sha256: hash(bytes),
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      files: Object.keys(files).sort(),
      source: {
        repository: "https://github.com/nestarc/inbox",
        workflow: ".github/workflows/release.yml",
        commit,
        ref: "refs/heads/main",
      },
    }),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  const log = join(directory, "npm-calls.jsonl");
  const npm = join(bin, "npm");
  // Stop at the installation boundary: no registry requests, database connection,
  // generated client, or broker process is needed to exercise candidate selection.
  await writeFile(
    npm,
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
let tarball;
if (args[0] === 'install') {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const dependency = manifest.dependencies?.['@nestarc/inbox'];
  tarball = dependency ? path.resolve(dependency.slice('file:'.length)) : args.at(-1);
}
fs.appendFileSync(process.env.CANDIDATE_TEST_LOG, JSON.stringify({
  args, tarball,
  sha256: tarball ? createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') : null,
  writable: tarball ? (fs.statSync(tarball).mode & 0o222) !== 0 : null,
}) + '\n');
if (process.env.CANDIDATE_TEST_TAMPER === 'metadata') fs.appendFileSync(process.env.INBOX_RELEASE_METADATA, '\n');
if (process.env.CANDIDATE_TEST_TAMPER === 'tarball') fs.appendFileSync(process.env.INBOX_RELEASE_TARBALL, 'tampered');
process.exit(81);
`,
  );
  await chmod(npm, 0o755);
  const name = "nestarc_inbox_test_0123456789abcdef";
  const url = `postgresql://inbox_test:fixture@127.0.0.1:5432/${name}`;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_URL: url,
    INBOX_TEST_DATABASE: "1",
    INBOX_TEST_DATABASE_URL: url,
    INBOX_TEST_DATABASE_NAME: name,
    INBOX_RELEASE_TARBALL: tarball,
    INBOX_RELEASE_METADATA: metadata,
    GITHUB_SHA: commit,
    GITHUB_REF: "refs/heads/main",
    CANDIDATE_TEST_LOG: log,
  };
  delete env.CANDIDATE_TEST_TAMPER;
  return {
    tarball,
    metadata,
    bytes,
    env,
    async calls() {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

async function run(script, env) {
  try {
    const result = await execute(
      process.execPath,
      [join(root, "scripts", script)],
      { env, cwd: root, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    return {
      code: error.code,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

for (const script of ["test-package.mjs", "test-examples.mjs"]) {
  describe(`${script} release candidate boundary`, () => {
    it("rejects partial and relative candidate configuration without repacking", async (t) => {
      const f = await fixture(t);
      const partial = { ...f.env };
      delete partial.INBOX_RELEASE_METADATA;
      for (const env of [
        partial,
        { ...f.env, INBOX_RELEASE_TARBALL: "relative.tgz" },
      ]) {
        const result = await run(script, env);
        assert.notEqual(result.code, 0);
        assert.match(
          result.output,
          /Set both INBOX_RELEASE_TARBALL and INBOX_RELEASE_METADATA to absolute paths/,
        );
      }
      assert.deepEqual(await f.calls(), []);
    });

    it("installs a byte-identical read-only candidate copy without building or packing", async (t) => {
      const f = await fixture(t);
      const result = await run(script, f.env);
      assert.notEqual(result.code, 0); // npm sentinel deliberately stops at install.
      assert.match(result.output, /npm (?:failed \(81\)|exited 81)/);
      const calls = await f.calls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args[0], "install");
      assert.notEqual(calls[0].tarball, f.tarball);
      assert.equal(calls[0].sha256, hash(f.bytes));
      assert.equal(calls[0].writable, false);
      assert.deepEqual(await readFile(f.tarball), f.bytes);
    });

    it("binds the candidate to the checkout version and requested commit before installation", async (t) => {
      const f = await fixture(t);
      const wrongCommit = await run(script, {
        ...f.env,
        GITHUB_SHA: "b".repeat(40),
      });
      assert.notEqual(wrongCommit.code, 0);
      assert.match(wrongCommit.output, /Candidate commit mismatch/);
      assert.deepEqual(await f.calls(), []);
      const wrongVersion = await fixture(t, { version: "999.0.0" });
      const result = await run(script, wrongVersion.env);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /Candidate version mismatch/);
      assert.deepEqual(await wrongVersion.calls(), []);
    });

    it("detects metadata replacement during a failed test run", async (t) => {
      const f = await fixture(t);
      const result = await run(script, {
        ...f.env,
        CANDIDATE_TEST_TAMPER: "metadata",
      });
      assert.notEqual(result.code, 0);
      assert.match(result.output, /Release candidate metadata changed during/);
      assert.equal((await f.calls()).length, 1);
    });

    it("detects candidate bytes changed during a failed test run", async (t) => {
      const f = await fixture(t);
      const result = await run(script, {
        ...f.env,
        CANDIDATE_TEST_TAMPER: "tarball",
      });
      assert.notEqual(result.code, 0);
      assert.match(
        result.output,
        /Tarball (?:size changed|SHA-256 mismatch|integrity mismatch)/,
      );
      assert.equal((await f.calls()).length, 1);
    });
  });
}
