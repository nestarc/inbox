import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { tenantId, waitUntil } from "../common";
import { startBrokerInbox } from "../broker-common";

// This example checks the SQS API contract against local ElasticMQ. It is not an
// AWS infrastructure, IAM, availability, or production SQS compatibility test.
async function main() {
  const configuredEndpoint = process.env.INBOX_EXAMPLE_SQS_ENDPOINT;
  if (!configuredEndpoint)
    throw new Error(
      "Set INBOX_EXAMPLE_SQS_ENDPOINT to the local ElasticMQ fixture.",
    );
  const endpoint = new URL(configuredEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("This example connects only to a local HTTP SQS fixture.");
  }
  const client = new SQSClient({
    region: "us-east-1",
    endpoint: endpoint.origin,
    // Explicit fixture credentials prevent the SDK from reading a real AWS profile.
    credentials: {
      accessKeyId: "local-fixture",
      secretAccessKey: "local-fixture",
    },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
  });
  const fixture = await startBrokerInbox("example.sqs.v1", "order.created").catch(
    (error: unknown) => {
      client.destroy();
      throw error;
    },
  );
  const inbox = fixture.app.get(InboxService);
  const prefix = `inbox-example-${randomUUID()}`;
  const createdQueues: string[] = [];
  const eventId = randomUUID();
  const orderId = randomUUID();
  let acceptedDeliveries = 0;
  let quarantinedDeliveries = 0;
  let transientFailures = 0;
  let redelivered = false;
  let injectAcceptanceFailure = true;

  function localQueueUrl(value: string | undefined): string {
    if (!value) throw new Error("The SQS fixture did not return a queue URL.");
    // ElasticMQ advertises its container port by default. Preserve the queue path
    // while using the explicitly configured mapped loopback port for every call.
    const queue = new URL(value);
    return new URL(queue.pathname, endpoint.origin).href;
  }

  async function createQueue(
    suffix: string,
    attributes: Record<string, string> = {},
  ): Promise<string> {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: `${prefix}-${suffix}`,
        Attributes: attributes,
      }),
    );
    const url = localQueueUrl(result.QueueUrl);
    createdQueues.push(url);
    return url;
  }

  async function deleteMessage(queueUrl: string, message: Message) {
    assert.ok(
      message.ReceiptHandle,
      "Received messages must have a receipt handle.",
    );
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  try {
    const deadQueue = await createQueue("dead");
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadQueue,
        AttributeNames: ["QueueArn"],
      }),
    );
    assert.ok(attributes.Attributes?.QueueArn);
    const queue = await createQueue("main", {
      VisibilityTimeout: "30",
      ReceiveMessageWaitTimeSeconds: "1",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: attributes.Attributes.QueueArn,
        maxReceiveCount: "3",
      }),
    });
    const body = JSON.stringify({ eventId, orderId });
    for (let index = 0; index < 2; index++) {
      await client.send(
        new SendMessageCommand({ QueueUrl: queue, MessageBody: body }),
      );
    }
    await client.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: "invalid-json-fixture",
      }),
    );

    const deadline = Date.now() + 40_000;
    while (acceptedDeliveries < 2 || quarantinedDeliveries < 1) {
      if (Date.now() > deadline)
        throw new Error("SQS ingress fixture timed out.");
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queue,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      for (const message of result.Messages ?? []) {
        assert.ok(message.ReceiptHandle);
        if (Number(message.Attributes?.ApproximateReceiveCount) > 1)
          redelivered = true;
        try {
          if (!message.Body || Buffer.byteLength(message.Body) > 256 * 1024)
            throw new InboxValidationError("Missing or oversized SQS body.");
          let value: unknown;
          try {
            value = JSON.parse(message.Body);
          } catch {
            throw new InboxValidationError("Invalid SQS JSON body.");
          }
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof (value as { eventId?: unknown }).eventId !== "string" ||
            typeof (value as { orderId?: unknown }).orderId !== "string"
          ) {
            throw new InboxValidationError(
              "SQS eventId and orderId must be strings.",
            );
          }
          const incoming = value as { eventId: string; orderId: string };
          // Fault injection proves that acceptance failure leaves the broker copy
          // available. Production code simply calls accept without this branch.
          if (injectAcceptanceFailure) {
            injectAcceptanceFailure = false;
            throw new Error("Injected pre-acceptance storage failure");
          }
          await inbox.accept({
            // Bind authenticated queue/account routes to a trusted tenant. Neither
            // the SQS MessageId nor the receipt handle is the producer's event ID.
            scope: { kind: "tenant", id: tenantId },
            source: "example-sqs-orders",
            consumer: "example.sqs.v1",
            messageId: incoming.eventId,
            eventType: "order.created",
            schemaVersion: 1,
            payload: { orderId: incoming.orderId },
          });
        } catch (error) {
          if (
            error instanceof InboxConflictError ||
            error instanceof InboxValidationError
          ) {
            // Confirm quarantine persistence before deleting the original copy.
            // A failed publish leaves the original available after visibility expiry.
            await client.send(
              new SendMessageCommand({
                QueueUrl: deadQueue,
                MessageBody: message.Body ?? "missing-body",
              }),
            );
            await deleteMessage(queue, message);
            quarantinedDeliveries++;
          } else {
            transientFailures++;
            // No DeleteMessage on failed/uncertain acceptance. A short visibility
            // backoff allows redelivery; queue redrive bounds persistent failures.
            await client.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queue,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 1,
              }),
            );
          }
          continue;
        }
        // Both accepted and duplicate mean durable receipt. Inbox now owns handler
        // retries, so this acknowledgement does not wait for business completion.
        await deleteMessage(queue, message);
        acceptedDeliveries++;
      }
    }
    await waitUntil(
      async () =>
        (await fixture.prisma.exampleProjection.count({
          where: { orderId, tenantId },
        })) === 1,
      "SQS duplicate deliveries and one projection",
    );
    const dead = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: deadQueue,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    assert.equal(dead.Messages?.[0]?.Body, "invalid-json-fixture");
    assert.equal(transientFailures, 1);
    assert.equal(redelivered, true);
    assert.equal(acceptedDeliveries, 2);
    assert.equal(quarantinedDeliveries, 1);
    assert.ok(fixture.retries() >= 1, "Inbox owns retries after SQS acceptance.");
    console.log(
      JSON.stringify({
        transport: "ElasticMQ (SQS-compatible emulator)",
        acceptedDeliveries,
        projections: 1,
        transientFailures,
        handlerRetries: fixture.retries(),
        redelivered,
        quarantinedDeliveries,
      }),
    );
  } finally {
    const cleanup = await Promise.allSettled(
      createdQueues
        .reverse()
        .map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    client.destroy();
    await fixture.close();
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
