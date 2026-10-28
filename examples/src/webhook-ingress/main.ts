import assert from "node:assert/strict";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { startInbox, tenantId, waitUntil } from "../common";

const maxBytes = 16 * 1024;

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes)
      throw new InboxValidationError("Webhook body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const secret = process.env.INBOX_EXAMPLE_WEBHOOK_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error(
      "Set INBOX_EXAMPLE_WEBHOOK_SECRET to a random secret of at least 32 bytes.",
    );
  }
  const fixture = await startInbox("example.webhook.v1", "order.created");
  const inbox = fixture.app.get(InboxService);
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== "POST" ||
        request.url !== "/webhooks/example-account"
      ) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await body(request);
      const timestamp = request.headers["x-example-timestamp"];
      const signature = request.headers["x-example-signature"];
      if (
        typeof timestamp !== "string" ||
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        typeof signature !== "string" ||
        !/^[a-f0-9]{64}$/.test(signature)
      ) {
        response.writeHead(401).end();
        return;
      }
      const expected = createHmac("sha256", secret)
        .update(timestamp)
        .update(".")
        .update(bytes)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
        response.writeHead(401).end();
        return;
      }
      // Signature verification precedes JSON interpretation and tenant assignment.
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as { id?: unknown }).id !== "string" ||
        typeof (parsed as { orderId?: unknown }).orderId !== "string"
      ) {
        response.writeHead(400).end();
        return;
      }
      const event = parsed as { id: string; orderId: string };
      const result = await inbox.accept({
        scope: { kind: "tenant", id: tenantId }, // server-side account → tenant mapping
        source: "example-webhook-account",
        consumer: "example.webhook.v1",
        messageId: event.id,
        eventType: "order.created",
        schemaVersion: 1,
        payload: { orderId: event.orderId },
      });
      response.writeHead(result.kind === "accepted" ? 202 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ kind: result.kind }));
    })().catch((error: unknown) => {
      const status =
        error instanceof InboxConflictError
          ? 409
          : error instanceof InboxValidationError
            ? 400
            : 503;
      if (!response.headersSent) response.writeHead(status);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/webhooks/example-account`;
    const orderId = randomUUID();
    const content = JSON.stringify({ id: randomUUID(), orderId });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${content}`)
      .digest("hex");
    const headers = {
      "content-type": "application/json",
      "x-example-timestamp": timestamp,
      "x-example-signature": signature,
    };
    const rejected = await fetch(url, {
      method: "POST",
      body: content,
      headers: { ...headers, "x-example-signature": "0".repeat(64) },
    });
    assert.equal(rejected.status, 401);
    await rejected.arrayBuffer();
    const first = await fetch(url, { method: "POST", body: content, headers });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { kind: "accepted" });
    const duplicate = await fetch(url, {
      method: "POST",
      body: content,
      headers,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { kind: "duplicate" });
    await waitUntil(
      async () =>
        (await fixture.prisma.exampleProjection.count({
          where: { tenantId, orderId },
        })) === 1,
      "signed webhook projection",
    );
    console.log(
      JSON.stringify({
        invalidSignature: 401,
        accepted: 202,
        duplicate: 200,
        projections: 1,
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
