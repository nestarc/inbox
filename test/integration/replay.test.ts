import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InboxAdminService,
  type InboxReplayOptions,
} from "../../src/inbox-admin.service";
import {
  InboxBackpressureError,
  InboxReplayConflictError,
  InboxSchemaError,
  InboxStateConflictError,
} from "../../src/contracts/errors";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import {
  consumer,
  createFixture,
  envelope,
  runOptions,
  tenant,
  writeEffects,
} from "./fixture";

describe("durable completed replay", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => {
    fixture = await createFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  async function completed() {
    const message = envelope();
    const receipt = await fixture.storage.accept(message);
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "original-worker",
      5000,
      3,
    );
    await fixture.storage.run(
      claimed!,
      (tx) => writeEffects(tx, receipt.id),
      runOptions,
    );
    const original = (await fixture.storage.get(receipt.id))!;
    const request: InboxReplayOptions = {
      id: original.id,
      expectedVersion: original.rowVersion,
      requestId: randomUUID(),
      targetConsumer: "orders.rebuild.v2",
      actor: "operator",
      reason: "Rebuild projection",
    };
    return { message, original, request };
  }

  it("creates one new receipt under concurrent retries and preserves the original identity and effects", async () => {
    const { original, message, request } = await completed();
    const admin = new InboxAdminService(fixture.storage).forTenant(tenant.id);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => admin.replay(request)),
    );
    expect(outcomes.filter((r) => r.kind === "accepted")).toHaveLength(1);
    expect(new Set(outcomes.map((r) => r.record.id)).size).toBe(1);
    const replay = outcomes[0]!.record;
    expect(replay).toMatchObject({
      status: "PENDING",
      consumer: request.targetConsumer,
      source: original.source,
      payload: original.payload,
      eventType: original.eventType,
      schemaVersion: original.schemaVersion,
      fingerprint: original.fingerprint,
      attemptCount: 0,
      replay: {
        originalInboxId: original.id,
        requestId: request.requestId,
        sourceVersion: original.rowVersion,
        actor: request.actor,
        reason: request.reason,
      },
    });
    expect(replay.id).not.toBe(original.id);
    expect(replay.messageId).not.toBe(original.messageId);
    expect(replay.replay?.requestedAt).toBeInstanceOf(Date);
    expect(await fixture.storage.get(original.id)).toEqual(original);
    expect(await fixture.storage.accept(message)).toEqual({
      kind: "duplicate",
      id: original.id,
      status: "COMPLETED",
    });
    const [claimed] = await fixture.storage.claim(
      [request.targetConsumer],
      1,
      "replay-worker",
      5000,
      3,
    );
    await fixture.storage.run(
      claimed!,
      (tx) => writeEffects(tx, replay.id),
      runOptions,
    );
    expect(await fixture.effects(replay.id)).toEqual({
      business: 1,
      outbox: 1,
    });
    expect(await fixture.effects(original.id)).toEqual({
      business: 1,
      outbox: 1,
    });
    expect(await admin.replay(request)).toMatchObject({
      kind: "duplicate",
      record: { id: replay.id, status: "COMPLETED" },
    });
  });

  it("retries a committed replay after payload cleanup but rejects a fresh replay of a purged original", async () => {
    const { original, request } = await completed();
    const admin = new InboxAdminService(fixture.storage).forTenant(tenant.id);
    const replay = await admin.replay(request);
    await admin.purgeCompletedPayload({ before: new Date(Date.now() + 1000) });
    expect((await admin.get(original.id))?.payloadPurged).toBe(true);
    expect(await admin.replay(request)).toMatchObject({
      kind: "duplicate",
      record: { id: replay.record.id, payload: original.payload },
    });
    await expect(
      admin.replay({ ...request, requestId: randomUUID() }),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
    const [claimed] = await fixture.storage.claim(
      [request.targetConsumer],
      1,
      "replay-worker",
      5000,
      3,
    );
    await fixture.storage.run(claimed!, async () => {}, runOptions);
    await admin.purgeCompletedPayload({ before: new Date(Date.now() + 1000) });
    expect(await admin.replay(request)).toMatchObject({
      kind: "duplicate",
      record: {
        id: replay.record.id,
        status: "COMPLETED",
        payloadPurged: true,
        replay: { originalInboxId: original.id, requestId: request.requestId },
      },
    });
  });

  it("requires a scoped completed record and matching version", async () => {
    const { request } = await completed();
    const admins = new InboxAdminService(fixture.storage);
    await expect(
      admins.forTenant("tenant-b").replay(request),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
    await expect(admins.forGlobal().replay(request)).rejects.toBeInstanceOf(
      InboxStateConflictError,
    );
    await expect(
      admins.forTenant(tenant.id).replay({ ...request, expectedVersion: "1" }),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
    const pending = await fixture.storage.accept(envelope());
    await expect(
      admins
        .forTenant(tenant.id)
        .replay({ ...request, id: pending.id, expectedVersion: "1" }),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
    expect((await fixture.storage.list()).records).toHaveLength(2);
  });

  it("rejects request reuse with different parameters, including a different original", async () => {
    const { request } = await completed();
    const admin = new InboxAdminService(fixture.storage).forTenant(tenant.id);
    await admin.replay(request);
    for (const override of [
      { targetConsumer: "other" },
      { reason: "different" },
      { actor: "other" },
      { expectedVersion: "1" },
    ]) {
      await expect(
        admin.replay({ ...request, ...override }),
      ).rejects.toBeInstanceOf(InboxReplayConflictError);
    }
    const next = await completed();
    await expect(
      admin.replay({ ...next.request, requestId: request.requestId }),
    ).rejects.toBeInstanceOf(InboxReplayConflictError);
  });

  it("enforces admission for new replays while keeping committed replay retries available", async () => {
    const { request } = await completed();
    const limited = new PrismaInboxStorage(fixture.prisma, {
      maxPendingMessages: 1,
    });
    const admin = new InboxAdminService(limited).forTenant(tenant.id);
    const replay = await admin.replay(request);
    expect(await admin.replay(request)).toMatchObject({
      kind: "duplicate",
      record: { id: replay.record.id },
    });
    await expect(
      admin.replay({ ...request, requestId: randomUUID() }),
    ).rejects.toBeInstanceOf(InboxBackpressureError);
    expect((await fixture.storage.list()).records).toHaveLength(2);
  });

  it("rejects an existing external receipt that occupied the synthetic replay identity", async () => {
    const { original, request } = await completed();
    await fixture.storage.accept(
      envelope({
        messageId: `replay:${original.id}:${request.requestId}`,
        consumer: request.targetConsumer,
      }),
    );
    await expect(
      new InboxAdminService(fixture.storage)
        .forTenant(tenant.id)
        .replay(request),
    ).rejects.toBeInstanceOf(InboxReplayConflictError);
    expect((await fixture.storage.list()).records).toHaveLength(2);
    expect(await fixture.storage.get(original.id)).toEqual(original);
  });

  it("migrates retained v1 receipts transactionally and verifies replay constraints", async () => {
    const { original, message, request } = await completed();
    const migration = await readFile(
      resolve("src/sql/migrate-v1-to-v2.sql"),
      "utf8",
    );
    await fixture.pool.query(`ALTER TABLE public.nestarc_inbox
      DROP COLUMN replay_of CASCADE, DROP COLUMN replay_request_id CASCADE,
      DROP COLUMN replay_source_version, DROP COLUMN replay_actor,
      DROP COLUMN replay_reason, DROP COLUMN replayed_at;
      UPDATE public.nestarc_inbox_schema SET version=1`);
    try {
      await expect(fixture.storage.assertSchema()).rejects.toBeInstanceOf(
        InboxSchemaError,
      );
    } finally {
      await fixture.pool.query(migration);
    }
    await fixture.pool.query(migration); // Re-applying a successful deployment is harmless.
    await fixture.storage.assertSchema();
    expect(await fixture.storage.get(original.id)).toEqual(original);
    expect(await fixture.storage.accept(message)).toMatchObject({
      kind: "duplicate",
      id: original.id,
    });
    expect(
      await new InboxAdminService(fixture.storage)
        .forTenant(tenant.id)
        .replay(request),
    ).toMatchObject({ kind: "accepted" });
    await fixture.pool.query(
      "ALTER TABLE public.nestarc_inbox DROP CONSTRAINT nestarc_inbox_replay_request_key",
    );
    try {
      await expect(fixture.storage.assertSchema()).rejects.toBeInstanceOf(
        InboxSchemaError,
      );
    } finally {
      await fixture.pool.query(migration);
    }
    await fixture.storage.assertSchema();
  });
});
