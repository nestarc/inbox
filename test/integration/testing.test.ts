import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InboxService } from "../../src/inbox.service";
import { drainInbox, waitForInboxRecord } from "../../src/testing";
import {
  consumer,
  createFixture,
  envelope,
  tenant,
  workerOptions,
  writeEffects,
} from "./fixture";

function message() {
  const { payloadJson, fingerprint, fingerprintVersion, ...value } = envelope();
  return value;
}

describe("testing helpers with the real service and PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let inbox: InboxService | undefined;
  beforeAll(async () => {
    fixture = await createFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterEach(async () => {
    await inbox?.close();
    inbox = undefined;
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("drains future retries, preserves duplicate identity and observes one committed set of effects", async () => {
    inbox = new InboxService({
      prisma: fixture.prisma,
      handlers: [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          async handle(_payload, context) {
            await writeEffects(context.tx, context.inboxId);
            if (context.attempt === 1) throw new Error("Retry after rollback");
          },
        },
      ],
      worker: workerOptions({ enabled: false }),
    });
    const event = message();
    const receipt = await inbox.accept(event);
    expect(await inbox.accept(event)).toMatchObject({
      kind: "duplicate",
      id: receipt.id,
    });
    await inbox.runOnce();
    expect(await fixture.effects(receipt.id)).toEqual({});
    await fixture.pool.query(
      "UPDATE public.nestarc_inbox SET next_attempt_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1::uuid AND status='RETRYABLE'",
      [receipt.id],
    );
    const runOnce = vi.spyOn(inbox, "runOnce");
    const records = await drainInbox(
      inbox,
      inbox.admin.forTenant(tenant.id),
      [receipt.id],
      { timeoutMs: 3000 },
    );
    expect(records).toMatchObject([
      { id: receipt.id, status: "COMPLETED", attemptCount: 2 },
    ]);
    expect(runOnce.mock.results.length).toBeGreaterThan(1);
    expect(await runOnce.mock.results[0]!.value).toBe(0);
    expect(await fixture.effects(receipt.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });

  it("observes an automatically polling worker without manually running it", async () => {
    inbox = new InboxService({
      prisma: fixture.prisma,
      handlers: [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          async handle(_payload, context) {
            await writeEffects(context.tx, context.inboxId);
          },
        },
      ],
      worker: workerOptions(),
    });
    const receipt = await inbox.accept(message());
    const result = await waitForInboxRecord(
      inbox.admin.forTenant(tenant.id),
      receipt.id,
    );
    expect(result.status).toBe("COMPLETED");
    expect(await fixture.effects(receipt.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });

  it("supports expected DEAD assertions and rejects the same receipt as a successful drain", async () => {
    inbox = new InboxService({
      prisma: fixture.prisma,
      handlers: [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          async handle() {
            throw new Error("Expected test failure");
          },
        },
      ],
      worker: workerOptions({ enabled: false, maxAttempts: 1 }),
    });
    const receipt = await inbox.accept(message());
    const admin = inbox.admin.forTenant(tenant.id);
    await inbox.runOnce();
    expect(
      (await waitForInboxRecord(admin, receipt.id, { status: "DEAD" }))
        .attemptCount,
    ).toBe(1);
    await expect(drainInbox(inbox, admin, [receipt.id])).rejects.toMatchObject({
      code: "UNEXPECTED_TERMINAL_STATE",
    });
    await expect(
      waitForInboxRecord(inbox.admin.forTenant("another-tenant"), receipt.id, {
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      records: [{ id: receipt.id, status: null }],
    });
  });
});
