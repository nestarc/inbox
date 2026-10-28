import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import * as amqp from "amqplib";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { startInbox, tenantId, waitUntil } from "../common";

async function main() {
  const brokerUrl =
    process.env.INBOX_EXAMPLE_AMQP_URL ?? "amqp://guest:guest@127.0.0.1:55672";
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(brokerUrl).hostname)
  ) {
    throw new Error("This example connects only to a local RabbitMQ fixture.");
  }
  const fixture = await startInbox("example.rabbitmq.v1", "order.created");
  const connection = await amqp
    .connect(brokerUrl)
    .catch(async (error: unknown) => {
      await fixture.close();
      throw error;
    });
  const channel = await connection
    .createConfirmChannel()
    .catch(async (error: unknown) => {
      try {
        await connection.close();
      } finally {
        await fixture.close();
      }
      throw error;
    });
  const prefix = `inbox-example-${randomUUID()}`;
  const mainQueue = `${prefix}.main`;
  const retryQueue = `${prefix}.retry`;
  const deadQueue = `${prefix}.dead`;
  let callbackError: unknown;
  let acceptedDeliveries = 0;
  const pending = new Set<Promise<void>>();
  try {
    await channel.assertQueue(deadQueue, { durable: true });
    await channel.assertQueue(mainQueue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": deadQueue,
      },
    });
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        "x-message-ttl": 1_000,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": mainQueue,
      },
    });
    await channel.prefetch(1);
    const inbox = fixture.app.get(InboxService);
    const subscription = await channel.consume(
      mainQueue,
      (message) => {
        if (!message) return;
        const processing = (async () => {
          try {
            if (
              message.content.byteLength > 256 * 1024 ||
              !message.properties.messageId
            ) {
              channel.nack(message, false, false);
              return;
            }
            let payload: unknown;
            try {
              payload = JSON.parse(message.content.toString("utf8"));
            } catch {
              channel.nack(message, false, false);
              return;
            }
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload) ||
              typeof (payload as { orderId?: unknown }).orderId !== "string"
            ) {
              channel.nack(message, false, false);
              return;
            }
            await inbox.accept({
              // This fixture binds the authenticated broker route to one tenant.
              // Production routes must derive this from trusted configuration.
              scope: { kind: "tenant", id: tenantId },
              source: "example-rabbitmq-orders",
              consumer: "example.rabbitmq.v1",
              messageId: message.properties.messageId,
              eventType: "order.created",
              schemaVersion: 1,
              payload: payload as { orderId: string },
            });
            // Acceptance has committed. Handler failures are now Inbox's responsibility.
            channel.ack(message);
            acceptedDeliveries++;
          } catch (error) {
            if (
              error instanceof InboxConflictError ||
              error instanceof InboxValidationError
            ) {
              channel.nack(message, false, false);
              return;
            }
            const previous = message.properties.headers?.["x-example-retries"];
            const attempts =
              typeof previous === "number" &&
              Number.isSafeInteger(previous) &&
              previous >= 0
                ? previous
                : 0;
            if (attempts >= 3) {
              channel.nack(message, false, false);
              return;
            }
            try {
              channel.sendToQueue(retryQueue, message.content, {
                persistent: true,
                messageId: message.properties.messageId,
                contentType: "application/json",
                headers: { "x-example-retries": attempts + 1 },
              });
              await channel.waitForConfirms();
              channel.ack(message);
            } catch (publishError) {
              // Retain the unacknowledged delivery while backing off. With prefetch=1,
              // this avoids an immediate nack/requeue loop during a database outage.
              await setTimeout(1_000);
              try {
                channel.nack(message, false, true);
              } catch {
                /* connection loss requeues it */
              }
              callbackError = publishError;
            }
          }
        })()
          .catch((error: unknown) => {
            callbackError = error;
          })
          .finally(() => {
            pending.delete(processing);
          });
        pending.add(processing);
      },
      { noAck: false },
    );

    const orderId = randomUUID();
    const messageId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      channel.sendToQueue(mainQueue, Buffer.from(JSON.stringify({ orderId })), {
        persistent: true,
        messageId,
        contentType: "application/json",
      });
    }
    await channel.waitForConfirms();
    await waitUntil(async () => {
      if (callbackError) throw callbackError;
      return (
        (await fixture.prisma.exampleProjection.count({
          where: { orderId, tenantId },
        })) === 1 && acceptedDeliveries === 2
      );
    }, "RabbitMQ duplicate delivery and one projection");
    await channel.cancel(subscription.consumerTag);
    await Promise.all(pending);
    assert.equal(
      await fixture.prisma.exampleProjection.count({
        where: { orderId, tenantId },
      }),
      1,
    );
    console.log(
      JSON.stringify({ deliveriesPublished: 2, projections: 1, deadQueue }),
    );
  } finally {
    try {
      await channel.close();
    } finally {
      try {
        await connection.close();
      } finally {
        await fixture.close();
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
