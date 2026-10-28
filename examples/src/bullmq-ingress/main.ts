import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { tenantId, waitUntil } from "../common";
import {
  parseBrokerEvent,
  startBrokerInbox,
  type BrokerEvent,
} from "../broker-common";

async function main() {
  const value = process.env.INBOX_EXAMPLE_REDIS_URL;
  if (!value)
    throw new Error("Set INBOX_EXAMPLE_REDIS_URL to the local Redis fixture.");
  const url = new URL(value);
  if (
    url.protocol !== "redis:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw new Error(
      "This example uses only the unauthenticated local Redis fixture.",
    );
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
  };
  const name = `inbox-example-${randomUUID()}`;
  let callbackError: unknown;
  const queue = new Queue<BrokerEvent>(name, {
    connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 100 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  queue.on("error", (error) => {
    callbackError = error;
  });
  const fixture = await startBrokerInbox(
    "example.bullmq.v1",
    "order.created",
  ).catch(async (error: unknown) => {
    await queue.close();
    throw error;
  });
  const inbox = fixture.app.get(InboxService);
  let transportRetries = 0;
  let injectAcceptanceFailure = true;
  const worker = new Worker<BrokerEvent>(
    name,
    async (job) => {
      try {
        const event = parseBrokerEvent(job.data);
        // Fixture-only failure: BullMQ retries acceptance, not the business handler.
        if (injectAcceptanceFailure) {
          injectAcceptanceFailure = false;
          transportRetries++;
          throw new Error("Injected acceptance failure");
        }
        const receipt = await inbox.accept({
          scope: { kind: "tenant", id: tenantId },
          source: "example-bullmq-orders",
          consumer: "example.bullmq.v1",
          messageId: event.eventId,
          eventType: "order.created",
          schemaVersion: 1,
          payload: { orderId: event.orderId },
        });
        // Return only after the Inbox transaction commits. This completes the queue job.
        return receipt.kind;
      } catch (error) {
        if (
          error instanceof InboxValidationError ||
          error instanceof InboxConflictError
        )
          throw new UnrecoverableError(
            "Permanent ingress rejection; inspect the retained failed job.",
          );
        throw error;
      }
    },
    { connection, concurrency: 1, maxStalledCount: 1 },
  );
  worker.on("error", (error) => {
    callbackError = error;
  });
  try {
    await worker.waitUntilReady();
    const orderId = randomUUID();
    const eventId = randomUUID();
    // Different job IDs deliberately prove deduplication belongs to Inbox.
    const jobs = await queue.addBulk([
      {
        name: "order",
        data: { eventId, orderId },
        opts: { jobId: randomUUID() },
      },
      {
        name: "order",
        data: { eventId, orderId },
        opts: { jobId: randomUUID() },
      },
      {
        name: "invalid",
        data: { eventId: "", orderId: "" },
        opts: { jobId: randomUUID() },
      },
    ]);
    await waitUntil(async () => {
      if (callbackError) throw callbackError;
      return (
        (await jobs[0]!.getState()) === "completed" &&
        (await jobs[1]!.getState()) === "completed" &&
        (await jobs[2]!.getState()) === "failed" &&
        (await fixture.prisma.exampleProjection.count({
          where: { orderId, tenantId },
        })) === 1
      );
    }, "BullMQ acceptance retries, permanent failed jobs, and one projection");
    const failed = await queue.getJob(jobs[2]!.id!);
    assert.equal(failed?.attemptsMade, 1);
    assert.equal(transportRetries, 1);
    assert.equal(fixture.retries(), 1);
    console.log(
      JSON.stringify({
        broker: "BullMQ / Redis",
        completedJobs: 2,
        quarantinedJobs: 1,
        transportRetries,
        handlerRetries: fixture.retries(),
        projections: 1,
      }),
    );
  } finally {
    try {
      await worker.close();
    } finally {
      try {
        await queue.obliterate({ force: true });
      } finally {
        try {
          await queue.close();
        } finally {
          await fixture.close();
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
