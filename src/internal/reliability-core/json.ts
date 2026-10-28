import { createHash } from "node:crypto";

/** Strict JSON data shared by durable message and request boundaries. */
export class CanonicalJsonError extends TypeError {}

export function assertPlainJsonObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new CanonicalJsonError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new CanonicalJsonError(
        `${label} must contain only JSON data properties.`,
      );
    }
  }
}

/** Reject NUL and unpaired surrogates, which PostgreSQL JSON cannot store. */
export function isValidUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** v1: sorted UTF-16 object keys, JSON number/string encoding, original array order. */
export function canonicalJson(value: unknown, maxBytes = 262144): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new CanonicalJsonError("maxBytes must be a positive safe integer.");
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const chunks: string[] = [];
  const emit = (fragment: string): void => {
    bytes += Buffer.byteLength(fragment);
    if (bytes > maxBytes)
      throw new CanonicalJsonError("JSON exceeds maxBytes.");
    chunks.push(fragment);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 64)
      throw new CanonicalJsonError("JSON exceeds its structural limit.");
    if (item === null) return emit("null");
    if (typeof item === "boolean") return emit(String(item));
    if (typeof item === "number" && Number.isFinite(item))
      return emit(JSON.stringify(item));
    if (typeof item === "string") {
      if (!isValidUnicode(item) || Buffer.byteLength(item) > maxBytes)
        throw new CanonicalJsonError("Invalid or oversized JSON string.");
      return emit(JSON.stringify(item));
    }
    if (!item || typeof item !== "object")
      throw new CanonicalJsonError("Payload must contain only JSON values.");
    if (ancestors.has(item))
      throw new CanonicalJsonError("Cyclic payloads are not supported.");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (
        item.length > 100000 ||
        Reflect.ownKeys(item).length !== item.length + 1
      ) {
        throw new CanonicalJsonError(
          "Sparse arrays and extra array properties are not supported.",
        );
      }
      emit("[");
      for (let index = 0; index < item.length; index++) {
        if (index > 0) emit(",");
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor))
          throw new CanonicalJsonError("Array accessors are not supported.");
        visit(descriptor.value, depth + 1);
      }
      emit("]");
    } else {
      assertPlainJsonObject(item, "payload");
      emit("{");
      let first = true;
      for (const key of Object.keys(item).sort()) {
        if (!first) emit(",");
        first = false;
        if (!isValidUnicode(key) || Buffer.byteLength(key) > maxBytes)
          throw new CanonicalJsonError("Invalid JSON key.");
        emit(JSON.stringify(key));
        emit(":");
        visit(item[key], depth + 1);
      }
      emit("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return chunks.join("");
}

/** Optional domain separation keeps message fingerprints distinct from HTTP fingerprints. */
export function sha256Json(
  value: unknown,
  options: { domain?: string; maxBytes?: number } = {},
): string {
  const hash = createHash("sha256");
  if (options.domain !== undefined) {
    if (!options.domain || !isValidUnicode(options.domain))
      throw new CanonicalJsonError(
        "Fingerprint domain must be nonempty UTF-8 without NUL.",
      );
    hash.update(options.domain).update("\0");
  }
  return hash.update(canonicalJson(value, options.maxBytes)).digest("hex");
}
