import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InboxService } from "../../src/inbox.service";
import { PrismaClient } from "../prisma/generated";
import { requireTestDatabase } from "../prisma/fixture-guard";
import {
  consumer,
  createFixture,
  deferred,
  envelope,
  workerOptions,
  writeEffects,
} from "../integration/fixture";

describe("real PostgreSQL connection pool saturation", () => {
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

  it("rejects unpersisted acceptance during sustained saturation then drains with the same pool", async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: requireTestDatabase(),
        max: 2,
        connectionTimeoutMillis: 200,
      }),
    });
    const inbox = new InboxService({
      prisma,
      worker: workerOptions({ enabled: false, concurrency: 1 }),
      handlers: [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          handle: (_payload, context) =>
            writeEffects(context.tx, context.inboxId),
        },
      ],
    });
    const release = deferred();
    const occupied = [deferred(), deferred()];
    let blockers: Promise<unknown>[] = [];
    try {
      const { payloadJson, fingerprint, fingerprintVersion, ...message } =
        envelope();
      const receipt = await inbox.accept(message);
      blockers = occupied.map((ready) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe("SELECT 1");
            ready.resolve();
            await release.promise;
          },
          { timeout: 10_000 },
        ),
      );
      await Promise.all(occupied.map((ready) => ready.promise));
      const started = Date.now();
      let rejectedClaims = 0;
      while (Date.now() - started < 2_500) {
        await expect(inbox.runOnce()).rejects.toBeDefined();
        rejectedClaims++;
        expect((await fixture.storage.get(receipt.id))?.status).toBe("PENDING");
        await delay(50);
      }
      const {
        payloadJson: unusedJson,
        fingerprint: unusedHash,
        fingerprintVersion: unusedVersion,
        ...notAcknowledged
      } = envelope();
      await expect(inbox.accept(notAcknowledged)).rejects.toBeDefined();
      expect(
        Number(
          (
            await fixture.pool.query(
              "SELECT count(*) AS count FROM public.nestarc_inbox",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(await fixture.effects(receipt.id)).toEqual({});
      release.resolve();
      await Promise.all(blockers);
      const recoveryStarted = Date.now();
      await inbox.runOnce();
      expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
      expect(await fixture.effects(receipt.id)).toEqual({
        business: 1,
        outbox: 1,
      });
      expect(await inbox.accept(message)).toMatchObject({
        kind: "duplicate",
        id: receipt.id,
      });
      const redelivery = await inbox.accept(notAcknowledged);
      expect(redelivery.kind).toBe("accepted");
      await inbox.runOnce();
      expect(await fixture.effects(redelivery.id)).toEqual({
        business: 1,
        outbox: 1,
      });
      expect(Date.now() - recoveryStarted).toBeLessThan(3_000);
      console.log(
        JSON.stringify({
          operation: "pool-saturation",
          durationMs: Date.now() - started,
          rejectedClaims,
          recoveredReceipts: 2,
          recoveryMs: Date.now() - recoveryStarted,
        }),
      );
    } finally {
      release.resolve();
      await Promise.allSettled(blockers);
      await inbox.close();
      await prisma.$disconnect();
    }
  });
});
