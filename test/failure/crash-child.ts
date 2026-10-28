/** Process killed by crash-recovery.test.ts at named database boundaries. */
import type {
  InboxPrismaClient,
  InboxTransaction,
} from "../../src/contracts/types";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import {
  consumer,
  createFixture,
  envelope,
  wrapTransactions,
  writeEffects,
} from "../integration/fixture";

const mode = process.argv[2];
const hold = () =>
  new Promise<never>(() => {
    setInterval(() => {}, 1_000);
  });

async function main() {
  const fixture = await createFixture(false);
  if (mode === "accepted") {
    const receipt = await fixture.storage.accept(
      envelope({ messageId: process.argv[3]! }),
    );
    process.send?.({
      type: "ready",
      id: receipt.id,
      boundary: "accept-committed-before-ack",
    });
    await hold();
  }
  const [claimed] = await fixture.storage.claim(
    [consumer],
    1,
    "crash-child",
    750,
    3,
  );
  if (!claimed) throw new Error("No message available to claim.");
  if (mode === "claimed") {
    process.send?.({
      type: "ready",
      id: claimed.id,
      boundary: "claim-committed",
    });
    await hold();
  }
  if (mode !== "before-commit")
    throw new Error(`Unsupported crash boundary: ${mode}`);
  const wrapped = wrapTransactions(
    fixture.prisma,
    async <T>(
      fn: (tx: InboxTransaction) => Promise<T>,
      options?: Parameters<InboxPrismaClient["$transaction"]>[1],
    ) =>
      fixture.prisma.$transaction(async (tx) => {
        const result = await fn(tx);
        // fn contains the real storage completion CAS. COMMIT has not happened yet.
        process.send?.({
          type: "ready",
          id: claimed.id,
          boundary: "completion-cas-before-commit",
        });
        await hold();
        return result;
      }, options),
  );
  await new PrismaInboxStorage(wrapped).run(
    claimed,
    (tx) => writeEffects(tx, claimed.id),
    {
      timeoutMs: 10_000,
      maxWaitMs: 1_000,
      lockTimeoutMs: 1_000,
    },
  );
}

void main().catch((error: unknown) => {
  process.send?.({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
});
