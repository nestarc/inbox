import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForPublished } from "../../scripts/release-artifact.mjs";

const metadata = {
  name: "@nestarc/inbox",
  version: "0.1.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
};
const pending = { status: 404, ok: false };
const available = (integrity = metadata.integrity) => ({
  status: 200,
  ok: true,
  json: async () => ({
    name: metadata.name,
    version: metadata.version,
    dist: { integrity },
  }),
});

function clock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => elapsed,
    advance: (milliseconds) => {
      elapsed += milliseconds;
    },
    sleep: async (milliseconds) => {
      assert.ok(milliseconds > 0);
      sleeps.push(milliseconds);
      elapsed += milliseconds;
    },
  };
}

describe("npm publication availability", () => {
  it("accepts an already available matching version without waiting", async () => {
    const timer = clock();
    await waitForPublished(metadata, {
      ...timer,
      fetcher: async () => available(),
      onPending: () => assert.fail("An available package must not be pending"),
    });
    assert.deepEqual(timer.sleeps, []);
  });

  it("waits through fifteen minutes of scanning before verifying matching bytes", async () => {
    const timer = clock();
    const progress = [];
    let requests = 0;
    await waitForPublished(metadata, {
      ...timer,
      fetcher: async () => {
        requests++;
        return timer.now() < 15 * 60 * 1000 ? pending : available();
      },
      onPending: (event) => progress.push(event),
    });
    assert.equal(requests, 31);
    assert.equal(timer.now(), 15 * 60 * 1000);
    assert.deepEqual(timer.sleeps, Array(30).fill(30000));
    assert.equal(progress.length, 30);
    assert.deepEqual(progress.at(-1), {
      elapsedMs: 14.5 * 60 * 1000,
      waitMs: 30000,
      timeoutMs: 20 * 60 * 1000,
    });
  });

  it("bounds pending verification including request time and the final wait", async () => {
    const timer = clock();
    let requests = 0;
    await assert.rejects(
      waitForPublished(metadata, {
        ...timer,
        timeoutMs: 65000,
        fetcher: async () => {
          requests++;
          timer.advance(10000);
          return pending;
        },
      }),
      /Retry verify-published with the same artifact; do not publish again/,
    );
    assert.equal(timer.now(), 65000);
    assert.equal(requests, 2);
    assert.deepEqual(timer.sleeps, [30000, 15000]);
  });

  it("fails immediately if a pending version appears with different bytes", async () => {
    const timer = clock();
    let requests = 0;
    await assert.rejects(
      waitForPublished(metadata, {
        ...timer,
        fetcher: async () =>
          ++requests === 1 ? pending : available("sha512-other-bytes"),
      }),
      /Version already exists with different bytes/,
    );
    assert.equal(requests, 2);
    assert.deepEqual(timer.sleeps, [30000]);
  });

  it("does not retry non-404 registry responses or transport errors", async () => {
    for (const failure of [
      401,
      403,
      429,
      500,
      503,
      new Error("network failure"),
    ]) {
      const timer = clock();
      let requests = 0;
      await assert.rejects(
        waitForPublished(metadata, {
          ...timer,
          fetcher: async () => {
            requests++;
            if (failure instanceof Error) throw failure;
            return { status: failure, ok: false };
          },
        }),
        failure instanceof Error ? /network failure/ : /Registry lookup failed/,
      );
      assert.equal(requests, 1);
      assert.deepEqual(timer.sleeps, []);
    }
  });
});
