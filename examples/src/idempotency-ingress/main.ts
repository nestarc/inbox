import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgresStorage } from "@nestarc/idempotency/postgres";
import {
  InboxConflictError,
  InboxService,
  InboxValidationError,
} from "@nestarc/inbox";
import { Pool } from "pg";
import { exampleDatabaseUrl, startInbox, tenantId, waitUntil } from "../common";

/** An HTTP response cache may expire; the producer event ID must survive that expiry. */
async function main() {
  const fixture = await startInbox("example.idempotency.v1", "order.created");
  const pool = new Pool({ connectionString: exampleDatabaseUrl(), max: 4 });
  const tableName = `inbox_example_http_${randomUUID().replaceAll("-", "")}`;
  const storage = new PostgresStorage({ pool, tableName });
  const inbox = fixture.app.get(InboxService);
  let acceptCalls = 0;

  const server = createServer((request, response) => {
    const send = (status: number, body: string, replayed = false) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...(replayed ? { "idempotency-replayed": "true" } : {}),
      });
      response.end(body);
    };
    void (async () => {
      if (request.method !== "POST" || request.url !== "/events")
        return send(404, '{"error":"not found"}');
      const header = request.headers["idempotency-key"];
      if (typeof header !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(header))
        return send(400, '{"error":"invalid idempotency key"}');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) return send(413, '{"error":"body too large"}');
        chunks.push(bytes);
      }
      let event: { id: string; orderId: string };
      try {
        const input: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("invalid body");
        const value = input as Record<string, unknown>;
        if (
          Object.keys(value).some((key) => !["id", "orderId"].includes(key)) ||
          typeof value.id !== "string" ||
          typeof value.orderId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(value.id) ||
          !/^[a-f0-9-]{36}$/.test(value.orderId)
        )
          throw new Error("invalid event");
        event = { id: value.id, orderId: value.orderId };
      } catch {
        return send(400, '{"error":"invalid event"}');
      }

      // This local fixture's authenticated account is fixed. A real route must authenticate
      // before deriving tenantId and must scope its HTTP key by tenant and endpoint.
      const key = `${tenantId}:POST:/events:${header}`;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(event))
        .digest("hex");
      const claim = await storage.create(key, fingerprint, 5);
      if (!claim.acquired) {
        const current = await storage.get(key);
        if (!current) return send(503, '{"error":"retry acquisition"}');
        if (current.fingerprint !== fingerprint)
          return send(422, '{"error":"idempotency content conflict"}');
        if (current.status !== "COMPLETED")
          return send(409, '{"error":"request is processing"}');
        return send(current.statusCode!, current.responseBody!, true);
      }
      const token = claim.token;
      if (!token) return send(503, '{"error":"missing request ownership"}');
      try {
        acceptCalls++;
        const receipt = await inbox.accept({
          scope: { kind: "tenant", id: tenantId },
          source: "example-http-client",
          consumer: "example.idempotency.v1",
          messageId: event.id,
          eventType: "order.created",
          schemaVersion: 1,
          payload: { orderId: event.orderId },
        });
        const body = JSON.stringify({
          inboxId: receipt.id,
          kind: receipt.kind,
        });
        const completion = await storage.complete(
          key,
          token,
          { statusCode: 202, body },
          1,
        );
        if (completion !== "ok")
          return send(503, '{"error":"request ownership lost"}');
        return send(202, body);
      } catch (error) {
        // A retry uses the same producer event ID, even if the acceptance result was lost.
        await storage.delete(key, token).catch(() => undefined);
        if (error instanceof InboxConflictError)
          return send(422, '{"error":"event identity content conflict"}');
        if (error instanceof InboxValidationError)
          return send(400, '{"error":"invalid inbox envelope"}');
        return send(503, '{"error":"acceptance unavailable"}');
      }
    })().catch(() => send(503, '{"error":"storage unavailable"}'));
  });

  try {
    // A dedicated fixture only. Deploy the package's SQL migration explicitly in production.
    await PostgresStorage.createSchema(pool, tableName);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const idempotencyKey = randomUUID();
    const event = { id: randomUUID(), orderId: randomUUID() };
    const post = (body = event) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

    const first = await post();
    assert.equal(first.status, 202);
    const firstBody = await first.text();
    assert.equal(JSON.parse(firstBody).kind, "accepted");
    const replay = await post();
    assert.equal(replay.status, 202);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(await replay.text(), firstBody);
    assert.equal(acceptCalls, 1);
    const conflict = await post({ ...event, orderId: randomUUID() });
    assert.equal(conflict.status, 422);
    await conflict.text();
    assert.equal(acceptCalls, 1);

    await waitUntil(
      async () =>
        (await storage.get(`${tenantId}:POST:/events:${idempotencyKey}`)) ===
        null,
      "actual HTTP response retention expiry",
      5000,
    );
    // The HTTP record has expired, but Inbox still rejects event identity reuse.
    const durableConflict = await post({ ...event, orderId: randomUUID() });
    assert.equal(durableConflict.status, 422);
    await durableConflict.text();
    const afterExpiry = await post();
    assert.equal(afterExpiry.status, 202);
    const afterBody = (await afterExpiry.json()) as {
      inboxId: string;
      kind: string;
    };
    assert.equal(afterBody.kind, "duplicate");
    assert.equal(afterBody.inboxId, JSON.parse(firstBody).inboxId);
    assert.equal(acceptCalls, 3);
    await waitUntil(
      async () =>
        (await fixture.prisma.exampleProjection.count({
          where: { tenantId, orderId: event.orderId },
        })) === 1,
      "one durable business projection despite HTTP cache expiry",
    );
    console.log(
      JSON.stringify({
        responseReplay: true,
        afterExpiry: "duplicate",
        projections: 1,
      }),
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    try {
      await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } finally {
      await storage.close();
      await pool.end();
      await fixture.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
