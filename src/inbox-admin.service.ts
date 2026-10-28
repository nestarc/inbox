import type {
  InboxListOptions,
  InboxRecord,
  InboxScope,
} from "./contracts/types";
import { InboxValidationError } from "./contracts/errors";
import { boundedString, validateScope } from "./internal/validation";
import { PrismaInboxStorage } from "./storage/prisma/prisma-inbox.storage";

export interface InboxRequeueOptions {
  id: string;
  expectedVersion: string;
  reason: string;
  actor: string;
}
export interface InboxReplayOptions extends InboxRequeueOptions {
  /** Stable UUID identifying one operator request within the original record's scope. */
  requestId: string;
  /** May name the original consumer or a separately registered projection consumer. */
  targetConsumer: string;
}
export interface InboxReplayResult {
  kind: "accepted" | "duplicate";
  record: InboxRecord;
}
function id(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new InboxValidationError("Invalid inbox ID.");
  return value;
}
function version(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  ) {
    throw new InboxValidationError(
      "expectedVersion must be a positive bigint string.",
    );
  }
  return value;
}
/** A fixed scope is captured when this view is constructed. It is never read from request payloads. */
export class InboxAdminView {
  constructor(
    private readonly storage: PrismaInboxStorage,
    private readonly scope: InboxScope | undefined,
  ) {}
  get(recordId: string) {
    return this.storage.get(id(recordId), this.scope);
  }
  list(options: InboxListOptions = {}) {
    if (options.consumer !== undefined)
      boundedString(options.consumer, "consumer", 128);
    return this.storage.list(options, this.scope);
  }
  stats() {
    return this.storage.stats(this.scope);
  }
  requeue(options: InboxRequeueOptions) {
    id(options.id);
    return this.storage.requeue(
      options.id,
      this.scope,
      version(options.expectedVersion),
      boundedString(options.reason, "reason", 1024),
      boundedString(options.actor, "actor", 256),
    );
  }
  /** An intentional new delivery; the original COMPLETED receipt stays immutable. */
  replay(options: InboxReplayOptions): Promise<InboxReplayResult> {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw new InboxValidationError("Replay options must be a plain object.");
    const fields = [
      "id",
      "expectedVersion",
      "requestId",
      "targetConsumer",
      "reason",
      "actor",
    ];
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
      if (
        typeof key !== "string" ||
        !fields.includes(key) ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        throw new InboxValidationError(
          "Replay options contain an unsupported field.",
        );
    }
    return this.storage.replay(
      {
        id: id(options.id).toLowerCase(),
        expectedVersion: version(options.expectedVersion),
        requestId: id(options.requestId).toLowerCase(),
        targetConsumer: boundedString(
          options.targetConsumer,
          "targetConsumer",
          128,
        ),
        reason: boundedString(options.reason, "reason", 1024),
        actor: boundedString(options.actor, "actor", 256),
      },
      this.scope,
    );
  }
  purgeCompletedPayload(options: { before: Date; limit?: number }) {
    if (!(options.before instanceof Date))
      throw new InboxValidationError("before must be a Date.");
    return this.storage.purgeCompletedPayload(
      options.before,
      options.limit ?? 100,
      this.scope,
    );
  }
}
export class InboxAdminService {
  constructor(private readonly storage: PrismaInboxStorage) {}
  forTenant(tenantId: string): InboxAdminView {
    return new InboxAdminView(
      this.storage,
      validateScope({ kind: "tenant", id: tenantId }),
    );
  }
  forGlobal(): InboxAdminView {
    return new InboxAdminView(this.storage, { kind: "global" });
  }
}
/** Injected only when the module explicitly enables privilegedAdmin. Protect access in your app. */
export class InboxPrivilegedAdminService extends InboxAdminView {
  constructor(storage: PrismaInboxStorage) {
    super(storage, undefined);
  }
}
