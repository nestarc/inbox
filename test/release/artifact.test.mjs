import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  inspectArchive,
  registryStatus,
  releaseVersion,
  verifyArtifact as verifyArtifactFile,
} from "../../scripts/release-artifact.mjs";

const version = "0.1.0-preview.1";
const commit = process.env.GITHUB_SHA ?? "a".repeat(40);
const ref = process.env.GITHUB_REF ?? "refs/heads/main";
const repository = "https://github.com/nestarc/inbox";
const manifest = {
  name: "@nestarc/inbox",
  version,
  repository: { type: "git", url: `git+${repository}.git` },
  main: "dist/index.js",
  types: "dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      require: "./dist/index.js",
      default: "./dist/index.js",
    },
    "./sql/create-inbox-table.sql": "./src/sql/create-inbox-table.sql",
    "./testing": {
      types: "./dist/testing/index.d.ts",
      require: "./dist/testing/index.js",
      default: "./dist/testing/index.js",
    },
    "./sql/migrate-v1-to-v2.sql": "./src/sql/migrate-v1-to-v2.sql",
  },
};
const requiredFiles = {
  "dist/index.js": '"use strict"; module.exports = {};\n',
  "dist/index.d.ts": "export {};\n",
  "dist/testing/index.js": '"use strict"; module.exports = {};\n',
  "dist/testing/index.d.ts": "export {};\n",
  "src/sql/create-inbox-table.sql": "-- schema version 2\n",
  "src/sql/migrate-v1-to-v2.sql": "-- explicit v1 migration\n",
  "README.md": "# Inbox test artifact\n",
  LICENSE: "MIT fixture\n",
};

async function fixture(
  t,
  {
    packageManifest = manifest,
    files = {},
    omit = [],
    link,
    absolute = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "inbox-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, "staging");
  const packageDir = join(staging, "package");
  const contents = {
    ...requiredFiles,
    "package.json": `${JSON.stringify(packageManifest)}\n`,
    ...files,
  };
  for (const path of omit) delete contents[path];
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(packageDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  if (link) {
    const destination = join(packageDir, link.path);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(link.target, destination);
  }
  const tarball = join(root, "package.tgz");
  if (absolute) {
    execFileSync("tar", ["-czPf", tarball, packageDir], { stdio: "pipe" });
  } else {
    execFileSync("tar", ["-czf", tarball, "-C", staging, "package"], {
      stdio: "pipe",
    });
  }
  const bytes = await readFile(tarball);
  const metadata = {
    schemaVersion: 1,
    name: "@nestarc/inbox",
    version,
    filename: "package.tgz",
    size: bytes.length,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    files: [...Object.keys(contents), ...(link ? [link.path] : [])].sort(),
    source: {
      repository,
      commit,
      ref,
      workflow: ".github/workflows/release.yml",
    },
  };
  return { root, tarball, metadata, contents };
}

async function verifyArtifact(tarball, metadata, options) {
  const metadataPath = join(dirname(tarball), "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  return verifyArtifactFile(tarball, metadataPath, options);
}

async function verifyWithRef(tarball, metadata, githubRef) {
  const metadataPath = join(dirname(tarball), "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  const helperUrl = new URL(
    "../../scripts/release-artifact.mjs",
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { verifyArtifact } from ${JSON.stringify(helperUrl.href)};
       await verifyArtifact(process.argv[1], process.argv[2]);`,
      tarball,
      metadataPath,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        GITHUB_SHA: metadata.source.commit,
        GITHUB_REF: githubRef,
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

describe("release version selection", () => {
  it("routes stable versions to latest and prereleases to next", () => {
    assert.deepEqual(releaseVersion("1.2.3"), {
      version: "1.2.3",
      tag: "v1.2.3",
      distTag: "latest",
      prerelease: false,
    });
    assert.deepEqual(releaseVersion(version), {
      version,
      tag: `v${version}`,
      distTag: "next",
      prerelease: true,
    });
    assert.equal(releaseVersion("1.0.0-rc.2").distTag, "next");
  });

  it("rejects malformed versions rather than deriving unsafe release tags", () => {
    for (const value of [
      "",
      "v1.2.3",
      "1.2",
      "01.2.3",
      "1.2.3-../../escape",
      "1.2.3\n",
    ]) {
      assert.throws(() => releaseVersion(value), undefined, value);
    }
  });
});

describe("release artifact verification", () => {
  it("inspects and accepts the actual package, bundled private core, and documented examples", async (t) => {
    const { tarball, metadata } = await fixture(t, {
      files: {
        "dist/internal/reliability-core/index.js": "module.exports = {};\n",
        "dist/internal/reliability-core/index.d.ts": "export {};\n",
        "docs/usage.md": "# Usage\n",
        "examples/src/consumer/main.ts": "export {};\n",
        "examples/scripts/smoke.cjs": "// fixture runner\n",
        "examples/sql/application.sql": "-- application schema\n",
        "examples/prisma/schema.prisma": "// fixture model\n",
      },
    });
    const inspected = await inspectArchive(tarball);
    assert.equal(inspected.manifest.name, "@nestarc/inbox");
    assert.equal(inspected.manifest.version, version);
    assert.deepEqual([...inspected.files].sort(), metadata.files);
    const verified = await verifyArtifact(tarball, metadata, {
      expectedCommit: commit,
      expectedVersion: version,
    });
    assert.equal(verified.integrity, metadata.integrity);
    assert.equal(verified.source.commit, commit);
  });

  it("detects changed archive bytes even if the tar reader accepts trailing bytes", async (t) => {
    const { tarball, metadata } = await fixture(t);
    await writeFile(
      tarball,
      Buffer.concat([await readFile(tarball), Buffer.from("tampered")]),
    );
    await assert.rejects(() => verifyArtifact(tarball, metadata));
  });

  it("binds verification to the requested commit and version", async (t) => {
    const { tarball, metadata } = await fixture(t);
    await assert.rejects(() =>
      verifyArtifact(tarball, metadata, {
        expectedCommit:
          commit === "b".repeat(40) ? "c".repeat(40) : "b".repeat(40),
      }),
    );
    await assert.rejects(() =>
      verifyArtifact(tarball, metadata, { expectedVersion: "0.1.0-preview.2" }),
    );
  });

  it("rejects missing or changed metadata checksums, size, and file inventory", async (t) => {
    const { tarball, metadata } = await fixture(t);
    for (const changes of [
      { schemaVersion: 2 },
      { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
      { sha256: "0".repeat(64) },
      { size: metadata.size + 1 },
      { files: metadata.files.filter((path) => path !== "dist/index.js") },
      { files: [...metadata.files, "dist/undeclared.js"] },
    ]) {
      await assert.rejects(() =>
        verifyArtifact(tarball, { ...metadata, ...changes }),
      );
    }
  });

  it("requires the expected source repository and full commit identity", async (t) => {
    const { tarball, metadata } = await fixture(t);
    for (const changes of [
      { repository: "https://github.com/other/inbox" },
      { commit: commit.slice(0, 7) },
      { workflow: ".github/workflows/untrusted.yml" },
    ]) {
      await assert.rejects(() =>
        verifyArtifact(tarball, {
          ...metadata,
          source: { ...metadata.source, ...changes },
        }),
      );
    }
  });

  it("accepts qualified CI branch refs containing Unicode, plus signs, and at signs", async (t) => {
    const { tarball, metadata } = await fixture(t);
    for (const branchRef of [
      "refs/heads/codex/inbox+replay",
      "refs/heads/feature/user@tenant",
      "refs/heads/기능/인박스",
      "refs/heads/기능+재처리@검증",
    ]) {
      const result = await verifyWithRef(
        tarball,
        { ...metadata, source: { ...metadata.source, ref: branchRef } },
        branchRef,
      );
      assert.equal(result.status, 0, `${branchRef}: ${result.stderr}`);
    }
  });

  it("rejects unqualified refs and refs containing whitespace or control characters", async (t) => {
    const { tarball, metadata } = await fixture(t);
    for (const invalidRef of [
      "main",
      "heads/main",
      "refs/heads/",
      "refs/other/main",
      "refs/heads/with space",
      "refs/heads/with\ttab",
      "refs/heads/with\nnewline",
      "refs/heads/trailing-newline\n",
      "refs/heads/with\rreturn",
      "refs/heads/with\u0000nul",
      "refs/heads/with\u001fcontrol",
      "refs/heads/with\u007fdelete",
    ]) {
      const result = await verifyWithRef(
        tarball,
        { ...metadata, source: { ...metadata.source, ref: invalidRef } },
        "", // Disable event binding so this checks the ref format itself.
      );
      assert.notEqual(result.status, 0, JSON.stringify(invalidRef));
      assert.match(result.stderr, /did not match the regular expression/);
    }
  });

  it("still binds accepted Unicode refs to the exact GitHub event ref", async (t) => {
    const { tarball, metadata } = await fixture(t);
    const result = await verifyWithRef(
      tarball,
      {
        ...metadata,
        source: { ...metadata.source, ref: "refs/heads/기능+재처리@검증" },
      },
      "refs/heads/기능+재처리@다른검증",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Candidate ref mismatch/);
  });

  it("checks the embedded manifest instead of trusting metadata labels", async (t) => {
    for (const changes of [
      { name: "@nestarc/other" },
      { version: "9.9.9" },
      {
        repository: {
          type: "git",
          url: "git+https://github.com/other/inbox.git",
        },
      },
    ]) {
      const { tarball, metadata } = await fixture(t, {
        packageManifest: { ...manifest, ...changes },
      });
      await assert.rejects(() => verifyArtifact(tarball, metadata));
    }
  });

  it("never publishes the private workspace as the public package", async (t) => {
    const { tarball, metadata } = await fixture(t, {
      packageManifest: {
        ...manifest,
        name: "@nestarc/reliability-core",
        private: true,
      },
    });
    await assert.rejects(() => verifyArtifact(tarball, metadata));
    const privateInbox = await fixture(t, {
      packageManifest: { ...manifest, private: true },
    });
    await assert.rejects(() =>
      verifyArtifact(privateInbox.tarball, privateInbox.metadata),
    );
  });

  it("requires public entrypoints to resolve to the verified runtime and SQL assets", async (t) => {
    for (const changes of [
      { main: "docs/usage.md" },
      { types: "src/contracts/types.ts" },
      { exports: { ...manifest.exports, "./testing": "./dist/index.js" } },
      {
        exports: {
          ...manifest.exports,
          "./sql/migrate-v1-to-v2.sql": "./src/sql/create-inbox-table.sql",
        },
      },
    ]) {
      const { tarball, metadata } = await fixture(t, {
        packageManifest: { ...manifest, ...changes },
      });
      await assert.rejects(() => verifyArtifact(tarball, metadata));
    }
  });

  it("requires the public entrypoints and both schema installation and upgrade assets", async (t) => {
    for (const path of [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
      "src/sql/create-inbox-table.sql",
      "src/sql/migrate-v1-to-v2.sql",
    ]) {
      const { tarball, metadata } = await fixture(t, { omit: [path] });
      await assert.rejects(() => verifyArtifact(tarball, metadata));
    }
  });

  it("rejects dependencies, tests, generated clients, env files, and private source packages", async (t) => {
    for (const path of [
      "node_modules/dependency/index.js",
      "examples/node_modules/dependency/index.js",
      "test/integration/database.test.ts",
      "examples/src/generated/prisma/client.ts",
      ".env",
      "examples/.env.local",
      "dist/.env.production",
      "src/internal/reliability-core/package.json",
      "scripts/publish.mjs",
    ]) {
      const { tarball, metadata } = await fixture(t, {
        files: { [path]: "fixture\n" },
      });
      await assert.rejects(
        () => verifyArtifact(tarball, metadata),
        undefined,
        path,
      );
    }
  });

  it("rejects symlinks even when they point at another allowed archive member", async (t) => {
    const { tarball, metadata } = await fixture(t, {
      link: { path: "dist/alias.js", target: "index.js" },
    });
    await assert.rejects(() => verifyArtifact(tarball, metadata));
  });

  it("rejects absolute archive paths without extracting them", async (t) => {
    const { tarball, metadata } = await fixture(t, { absolute: true });
    await assert.rejects(() => verifyArtifact(tarball, metadata));
  });
});

describe("registry publication decisions", () => {
  const metadata = {
    name: "@nestarc/inbox",
    version,
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  };

  it("allows publication only after an explicit 404 response", async () => {
    let requested;
    const status = await registryStatus(metadata, async (url, options) => {
      requested = url;
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return { status: 404, ok: false };
    });
    assert.equal(
      requested,
      `https://registry.npmjs.org/%40nestarc%2Finbox/${version}`,
    );
    assert.equal(status, "publish");
  });

  it("skips a retry only when the existing version has the exact tested integrity", async () => {
    assert.equal(
      await registryStatus(metadata, async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          name: metadata.name,
          version: metadata.version,
          dist: { integrity: metadata.integrity },
        }),
      })),
      "skip",
    );
  });

  it("fails closed on registry authentication, throttling, server, and transport errors", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      await assert.rejects(() =>
        registryStatus(metadata, async () => ({ ok: false, status })),
      );
    }
    await assert.rejects(
      () =>
        registryStatus(metadata, async () => {
          throw new Error("network unavailable");
        }),
      /network unavailable/,
    );
  });

  it("refuses a published version with different bytes, identity, or invalid response data", async () => {
    for (const published of [
      { name: metadata.name, version, dist: { integrity: "sha512-different" } },
      {
        name: "@nestarc/other",
        version,
        dist: { integrity: metadata.integrity },
      },
      {
        name: metadata.name,
        version: "9.9.9",
        dist: { integrity: metadata.integrity },
      },
      { name: metadata.name, version },
      null,
    ]) {
      await assert.rejects(() =>
        registryStatus(metadata, async () => ({
          ok: true,
          status: 200,
          json: async () => published,
        })),
      );
    }
    await assert.rejects(() =>
      registryStatus(metadata, async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("invalid registry JSON");
        },
      })),
    );
  });
});
