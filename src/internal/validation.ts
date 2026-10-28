import {
  CanonicalJsonError,
  assertPlainJsonObject,
  canonicalJson as serializeCanonicalJson,
  isValidUnicode as validUnicode,
  sha256Json,
} from "./reliability-core";
import { InboxValidationError } from "../contracts/errors";
import type {
  InboxEnvelope,
  InboxScope,
  JsonValue,
  NormalizedEnvelope,
} from "../contracts/types";

function plain(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  try {
    assertPlainJsonObject(value, label);
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      throw new InboxValidationError(error.message);
    throw error;
  }
}

function allowed(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new InboxValidationError(`${label} contains an unsupported field.`);
  }
}
export function boundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !validUnicode(value) ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw new InboxValidationError(
      `${label} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL.`,
    );
  }
  return value;
}
export function validateScope(value: unknown): InboxScope {
  plain(value, "scope");
  if (value.kind === "global") {
    allowed(value, ["kind"], "scope");
    return { kind: "global" };
  }
  if (value.kind === "tenant") {
    allowed(value, ["kind", "id"], "scope");
    return { kind: "tenant", id: boundedString(value.id, "scope.id", 128) };
  }
  throw new InboxValidationError("scope.kind must be tenant or global.");
}
/** Preserve the public Inbox error contract around the shared strict JSON encoder. */
export function canonicalJson(value: unknown, maxBytes = 262144): string {
  try {
    return serializeCanonicalJson(value, maxBytes);
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      throw new InboxValidationError(
        error.message.replace("maxBytes", "maxPayloadBytes"),
      );
    throw error;
  }
}

export function normalizeEnvelope(
  input: InboxEnvelope,
  consumers: string[],
  maxPayloadBytes = 262144,
): NormalizedEnvelope {
  plain(input, "envelope");
  allowed(
    input,
    [
      "scope",
      "source",
      "consumer",
      "messageId",
      "eventType",
      "schemaVersion",
      "payload",
      "correlationId",
      "causationId",
      "headers",
    ],
    "envelope",
  );
  const scope = validateScope(input.scope);
  const source = boundedString(input.source, "source", 128);
  const consumer = boundedString(input.consumer, "consumer", 128);
  if (!consumers.includes(consumer))
    throw new InboxValidationError(
      "The consumer is not allowed by this ingress.",
    );
  const messageId = boundedString(input.messageId, "messageId", 256);
  const eventType = boundedString(input.eventType, "eventType", 128);
  if (
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    input.schemaVersion > 2147483647
  ) {
    throw new InboxValidationError(
      "schemaVersion must be a positive 32-bit integer.",
    );
  }
  const payloadJson = canonicalJson(input.payload, maxPayloadBytes);
  const payload = JSON.parse(payloadJson) as JsonValue;
  let fingerprint: string;
  try {
    fingerprint = sha256Json(
      { eventType, schemaVersion: input.schemaVersion, payload },
      {
        domain: "nestarc.inbox.fingerprint.v1",
        maxBytes: maxPayloadBytes + 1024,
      },
    );
  } catch (error) {
    if (error instanceof CanonicalJsonError)
      throw new InboxValidationError(
        error.message.replace("maxBytes", "maxPayloadBytes"),
      );
    throw error;
  }
  const normalized: NormalizedEnvelope = {
    scope,
    source,
    consumer,
    messageId,
    eventType,
    schemaVersion: input.schemaVersion,
    payload,
    payloadJson,
    fingerprint,
    fingerprintVersion: 1,
  };
  for (const key of ["correlationId", "causationId"] as const) {
    if (input[key] !== undefined)
      normalized[key] = boundedString(input[key], key, 256);
  }
  if (input.headers !== undefined) {
    plain(input.headers, "headers");
    allowed(input.headers, ["traceparent", "tracestate"], "headers");
    normalized.headers = {};
    for (const key of ["traceparent", "tracestate"] as const) {
      if (input.headers[key] !== undefined)
        normalized.headers[key] = boundedString(input.headers[key], key, 512);
    }
  }
  return normalized;
}
