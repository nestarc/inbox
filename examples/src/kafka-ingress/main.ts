import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { tenantId, waitUntil } from "../common";
import { parseBrokerEvent, startBrokerInbox } from "../broker-common";

async function main() {
  const broker = process.env.INBOX_EXAMPLE_KAFKA_BROKER;
  if (!broker || !/^127\.0\.0\.1:\d+$/.test(broker))
    throw new Error(
      "Set INBOX_EXAMPLE_KAFKA_BROKER to the local fixture host:port.",
    );
  const name = `inbox-example-${randomUUID()}`;
  const topic = `${name}-orders`;
  const deadTopic = `${name}-dead`;
  const kafka = new Kafka({
    clientId: name,
    brokers: [broker],
    logLevel: logLevel.ERROR,
    connectionTimeout: 5_000,
    requestTimeout: 10_000,
    retry: { retries: 3, initialRetryTime: 100, maxRetryTime: 1_000 },
  });
  const admin = kafka.admin();
  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId: name, sessionTimeout: 30_000 });
  const fixture = await startBrokerInbox("example.kafka.v1", "order.created");
  let callbackError: unknown;
  let accepted = 0;
  let quarantined = 0;
  let transportRetries = 0;
  let injectAcceptanceFailure = true;
  const createdTopics: string[] = [];
  try {
    await admin.connect();
    for (const candidate of [topic, deadTopic]) {
      await admin.createTopics({
        topics: [{ topic: candidate, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
      createdTopics.push(candidate);
    }
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: true });
    const inbox = fixture.app.get(InboxService);
    await consumer.run({
      autoCommit: false,
      // Sequential processing inside each partition prevents committing across a gap.
      partitionsConsumedConcurrently: 1,
      eachMessage: async ({
        topic: currentTopic,
        partition,
        message,
        heartbeat,
      }) => {
        try {
          let received = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              if (!message.value || message.value.byteLength > 256 * 1024)
                throw new InboxValidationError("Missing or oversized event.");
              let parsed: unknown;
              try {
                parsed = JSON.parse(message.value.toString("utf8"));
              } catch {
                throw new InboxValidationError("Invalid JSON.");
              }
              const event = parseBrokerEvent(parsed);
              // Fixture-only failure: demonstrate that this offset is not committed yet.
              if (injectAcceptanceFailure) {
                injectAcceptanceFailure = false;
                throw new Error("Injected acceptance failure");
              }
              await inbox.accept({
                scope: { kind: "tenant", id: tenantId },
                source: "example-kafka-orders",
                consumer: "example.kafka.v1",
                messageId: event.eventId,
                eventType: "order.created",
                schemaVersion: 1,
                payload: { orderId: event.orderId },
              });
              received = true;
              accepted++;
              break;
            } catch (error) {
              const permanent =
                error instanceof InboxValidationError ||
                error instanceof InboxConflictError;
              if (permanent || attempt === 3) {
                // A durable DLQ publish must succeed before advancing the source offset.
                // A crash between publish and commit can duplicate DLQ entries; preserve
                // source coordinates so the DLQ consumer can deduplicate them.
                await producer.send({
                  topic: deadTopic,
                  acks: -1,
                  messages: [
                    {
                      key: `${currentTopic}/${partition}/${message.offset}`,
                      value: message.value,
                      headers: {
                        sourceTopic: currentTopic,
                        sourcePartition: String(partition),
                        sourceOffset: message.offset,
                      },
                    },
                  ],
                });
                quarantined++;
                break;
              }
              transportRetries++;
              await heartbeat();
              await setTimeout(100 * attempt);
            }
          }
          // Both durable acceptance and durable quarantine allow transport progress.
          // Handler execution is asynchronous; its retry schedule belongs to Inbox.
          await consumer.commitOffsets([
            {
              topic: currentTopic,
              partition,
              offset: String(BigInt(message.offset) + 1n),
            },
          ]);
          if (received) await heartbeat();
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    });
    const orderId = randomUUID();
    const eventId = randomUUID();
    await producer.send({
      topic,
      acks: -1,
      messages: [
        { value: JSON.stringify({ eventId, orderId }) },
        { value: JSON.stringify({ eventId, orderId }) },
        { value: "invalid-json" },
      ],
    });
    await waitUntil(
      async () => {
        if (callbackError) throw callbackError;
        const offsets = await admin.fetchOffsets({
          groupId: name,
          topics: [topic],
        });
        return (
          accepted === 2 &&
          quarantined === 1 &&
          offsets[0]?.partitions[0]?.offset === "3" &&
          (await fixture.prisma.exampleProjection.count({
            where: { orderId, tenantId },
          })) === 1
        );
      },
      "Kafka durable acceptance, contiguous offset commit, and quarantine",
      30_000,
    );
    assert.equal(transportRetries, 1);
    assert.equal(fixture.retries(), 1);
    const deadOffsets = await admin.fetchTopicOffsets(deadTopic);
    assert.equal(deadOffsets[0]?.high, "1");
    console.log(
      JSON.stringify({
        broker: "Kafka protocol / Redpanda fixture",
        accepted,
        quarantined,
        transportRetries,
        handlerRetries: fixture.retries(),
        projections: 1,
      }),
    );
  } finally {
    try {
      await consumer.disconnect();
    } finally {
      try {
        await producer.disconnect();
      } finally {
        try {
          if (createdTopics.length)
            await admin.deleteTopics({ topics: createdTopics });
        } finally {
          try {
            await admin.disconnect();
          } finally {
            await fixture.close();
          }
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
