import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/nestarc/inbox";
const workflow = ".github/workflows/release.yml";
const packageName = "@nestarc/inbox";
const maxBytes = 5 * 1024 * 1024;
const required = [
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "src/sql/create-inbox-table.sql",
  "src/sql/migrate-v1-to-v2.sql",
];

export function releaseVersion(version) {
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${numeric}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
  assert.ok(
    typeof version === "string" &&
      version.length <= 128 &&
      new RegExp(
        `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`,
      ).test(version),
    "Release version must be canonical SemVer without build metadata",
  );
  const prerelease = version.includes("-");
  return {
    version,
    tag: `v${version}`,
    distTag: prerelease ? "next" : "latest",
    prerelease,
  };
}

function command(executable, args, cwd = root) {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function assertPath(path) {
  assert.ok(/^[A-Za-z0-9._/-]+$/.test(path), `Invalid archive path: ${path}`);
  const parts = path.split("/");
  assert.ok(
    !parts.some(
      (part) =>
        [
          "",
          ".",
          "..",
          "node_modules",
          "generated",
          "test",
          "tests",
          "__tests__",
          ".git",
        ].includes(part) ||
        part === ".env" ||
        part.startsWith(".env."),
    ),
    `Forbidden archive path: ${path}`,
  );
  const allowed =
    ["package.json", "LICENSE", "README.md", "CHANGELOG.md"].includes(path) ||
    /^(?:dist|docs|src\/sql)\//.test(path) ||
    /^examples\/(?:README\.md|package\.json|tsconfig\.json|prisma\.config\.ts|compose\.yaml)$/.test(
      path,
    ) ||
    /^examples\/(?:src|scripts|sql|prisma)\//.test(path);
  assert.ok(allowed, `Non-allowlisted archive path: ${path}`);
}

export function inspectArchive(tarballPath) {
  const absolute = resolve(tarballPath);
  assert.ok(
    statSync(absolute).size > 0 && statSync(absolute).size <= maxBytes,
    "Invalid release tarball size",
  );
  gunzipSync(readFileSync(absolute), { maxOutputLength: 20 * 1024 * 1024 });
  // Inspect before extracting anything; links and special files are never accepted.
  const entries = command("tar", ["-tzf", absolute]).split("\n");
  const verbose = command("tar", ["-tvzf", absolute]).split("\n");
  assert.equal(
    entries.length,
    verbose.length,
    "Unexpected archive entry encoding",
  );
  assert.ok(entries.length <= 2000, "Release tarball contains too many files");
  const files = [];
  entries.forEach((entry, i) => {
    assert.ok(
      entry === "package/" || entry.startsWith("package/"),
      "Archive entry escapes package root",
    );
    assert.ok(
      !entry.split("/").some((part) => part === ".." || part === "."),
      "Archive traversal is forbidden",
    );
    const kind = verbose[i][0];
    assert.ok(
      kind === "-" || kind === "d",
      "Archive links and special files are forbidden",
    );
    if (kind === "d") {
      assert.ok(entry.endsWith("/"), "Malformed archive directory");
      return;
    }
    const path = entry.slice("package/".length);
    assertPath(path);
    files.push(path);
  });
  assert.equal(new Set(files).size, files.length, "Duplicate archive entries");
  files.sort();
  required.forEach((file) =>
    assert.ok(files.includes(file), `Missing release file: ${file}`),
  );
  const manifest = JSON.parse(
    command("tar", ["-xOzf", absolute, "package/package.json"]),
  );
  assert.equal(manifest.name, packageName, "Wrong release package");
  assert.notEqual(
    manifest.private,
    true,
    "Private workspaces cannot be published",
  );
  releaseVersion(manifest.version);
  assert.equal(
    manifest.repository?.url,
    `git+${repository}.git`,
    "Wrong package repository",
  );
  assert.equal(manifest.main, "dist/index.js");
  assert.equal(manifest.types, "dist/index.d.ts");
  for (const file of ["create-inbox-table.sql", "migrate-v1-to-v2.sql"]) {
    assert.equal(manifest.exports?.[`./sql/${file}`], `./src/sql/${file}`);
  }
  return { manifest, files };
}

function outputs(values) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
}

export async function verifyArtifact(tarballPath, metadataPath, options = {}) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.filename, "package.tgz");
  assert.equal(basename(tarballPath), metadata.filename);
  const bytes = readFileSync(tarballPath);
  assert.equal(metadata.size, bytes.length, "Tarball size changed");
  assert.equal(
    metadata.sha256,
    digest(bytes, "sha256"),
    "Tarball SHA-256 mismatch",
  );
  assert.equal(
    metadata.integrity,
    `sha512-${digest(bytes, "sha512", "base64")}`,
    "Tarball integrity mismatch",
  );
  const { manifest, files } = inspectArchive(tarballPath);
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  assert.deepEqual(metadata.files, files);
  assert.equal(metadata.source?.repository, repository);
  assert.equal(metadata.source?.workflow, workflow);
  assert.match(metadata.source?.commit ?? "", /^[0-9a-f]{40}$/);
  assert.match(
    metadata.source?.ref ?? "",
    /^refs\/(?:heads|tags|pull)\/[^\u0000-\u0020\u007f]+$/,
  );
  const expectedCommit = options.expectedCommit ?? process.env.GITHUB_SHA;
  if (expectedCommit)
    assert.equal(
      metadata.source.commit,
      expectedCommit,
      "Candidate commit mismatch",
    );
  if (options.expectedVersion)
    assert.equal(
      metadata.version,
      options.expectedVersion,
      "Candidate version mismatch",
    );
  if (process.env.GITHUB_REF)
    assert.equal(
      metadata.source.ref,
      process.env.GITHUB_REF,
      "Candidate ref mismatch",
    );
  return metadata;
}

export async function packArtifact(outputDirectory) {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const commit = command("git", ["rev-parse", "HEAD"]);
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA);
  const packed = JSON.parse(
    command("npm", [
      "pack",
      "--ignore-scripts",
      "--workspaces=false",
      "--json",
      "--pack-destination",
      directory,
    ]),
  );
  assert.equal(packed.length, 1, "Only the Inbox package may be packed");
  assert.equal(packed[0].name, packageName);
  assert.match(packed[0].filename, /^nestarc-inbox-[A-Za-z0-9.-]+\.tgz$/);
  const path = join(directory, "package.tgz");
  renameSync(join(directory, packed[0].filename), path);
  const bytes = readFileSync(path);
  const { manifest, files } = inspectArchive(path);
  assert.equal(
    packed[0].integrity,
    `sha512-${digest(bytes, "sha512", "base64")}`,
  );
  const metadata = {
    schemaVersion: 1,
    name: manifest.name,
    version: manifest.version,
    filename: "package.tgz",
    size: bytes.length,
    integrity: packed[0].integrity,
    sha256: digest(bytes, "sha256"),
    files,
    source: {
      repository,
      workflow,
      commit,
      ref: process.env.GITHUB_REF || command("git", ["symbolic-ref", "HEAD"]),
    },
  };
  writeFileSync(
    join(directory, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await verifyArtifact(path, join(directory, "metadata.json"));
  console.log(
    `Packed one candidate: ${metadata.name}@${metadata.version}, ${files.length} files, ${bytes.length} bytes`,
  );
  return metadata;
}

export function verifyReleaseRef() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = releaseVersion(manifest.version);
  const commit = command("git", ["rev-parse", "HEAD"]);
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    "nestarc/inbox",
    "Release must run in nestarc/inbox",
  );
  assert.equal(
    commit,
    process.env.GITHUB_SHA,
    "Checked-out commit differs from event",
  );
  if (process.env.GITHUB_EVENT_NAME === "release") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    assert.equal(event.action, "published");
    assert.equal(event.release?.draft, false);
    assert.equal(
      event.release?.tag_name,
      version.tag,
      "Release tag must match package version",
    );
    assert.equal(
      event.release?.prerelease,
      version.prerelease,
      "GitHub prerelease flag must match the version",
    );
    assert.equal(process.env.GITHUB_REF, `refs/tags/${version.tag}`);
    assert.equal(
      command("git", ["rev-parse", `refs/tags/${version.tag}^{commit}`]),
      commit,
      "Tag moved or points to a different commit",
    );
    command("git", [
      "fetch",
      "--no-tags",
      "origin",
      "main:refs/remotes/origin/main",
    ]);
    command("git", [
      "merge-base",
      "--is-ancestor",
      commit,
      "refs/remotes/origin/main",
    ]);
  } else {
    assert.equal(
      process.env.GITHUB_EVENT_NAME,
      "workflow_dispatch",
      "Unsupported release event",
    );
  }
  outputs({
    version: version.version,
    "dist-tag": version.distTag,
    prerelease: version.prerelease,
  });
  console.log(`Verified ${version.tag}: npm channel ${version.distTag}`);
  return version;
}

export async function registryStatus(
  metadata,
  fetcher = fetch,
  timeoutMs = 15000,
) {
  const response = await fetcher(
    `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${encodeURIComponent(metadata.version)}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (response.status === 404) return "publish";
  assert.ok(
    response.ok,
    `Registry lookup failed (${response.status}); refusing to assume version is absent`,
  );
  const published = await response.json();
  assert.equal(published.name, metadata.name);
  assert.equal(published.version, metadata.version);
  assert.equal(
    published.dist?.integrity,
    metadata.integrity,
    "Version already exists with different bytes",
  );
  return "skip";
}

export async function waitForPublished(
  metadata,
  {
    fetcher = fetch,
    sleep = setTimeout,
    now = () => performance.now(),
    timeoutMs = 20 * 60 * 1000,
    pollIntervalMs = 30000,
    onPending = () => {},
  } = {},
) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  while (now() < deadline) {
    // A final registry request must fit inside the remaining availability window.
    const requestTimeoutMs = Math.max(
      1,
      Math.ceil(Math.min(15000, deadline - now())),
    );
    if ((await registryStatus(metadata, fetcher, requestTimeoutMs)) === "skip")
      return;
    const elapsedMs = now() - startedAt;
    const waitMs = Math.min(pollIntervalMs, deadline - now());
    if (waitMs <= 0) break;
    onPending({ elapsedMs, waitMs, timeoutMs });
    await sleep(waitMs);
  }
  throw new Error(
    `Published version did not appear within ${timeoutMs / 60000} minutes. ` +
      "npm may still be scanning or reviewing it. Retry verify-published with the same artifact; do not publish again.",
  );
}

async function main() {
  const [action, first, second] = process.argv.slice(2);
  if (action === "ref") return verifyReleaseRef();
  if (action === "pack" && first) return packArtifact(first);
  assert.ok(
    first && second,
    "Usage: release-artifact.mjs ref | pack DIR | verify TGZ META | registry-check TGZ META | verify-published TGZ META",
  );
  const metadata = await verifyArtifact(resolve(first), resolve(second), {
    expectedVersion: JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).version,
  });
  if (action === "verify")
    return console.log(`Verified candidate ${metadata.integrity}`);
  if (action === "registry-check") {
    const status = await registryStatus(metadata);
    outputs({ action: status });
    return console.log(`Registry decision: ${status}`);
  }
  assert.equal(action, "verify-published", "Unknown release command");
  await waitForPublished(metadata, {
    onPending: ({ elapsedMs, waitMs, timeoutMs }) =>
      console.log(
        `Published version is not available yet; npm scanning may be pending. ` +
          `Checking again in ${Math.ceil(waitMs / 1000)}s ` +
          `(${Math.floor(elapsedMs / 1000)}s elapsed, ${timeoutMs / 60000} minute limit).`,
      ),
  });
  console.log("Published registry integrity matches the tested tarball");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
