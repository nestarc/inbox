import type { OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { InboxError } from "./contracts/errors";
import type {
  InboxEnvelope,
  InboxObservation,
  InboxOptions,
} from "./contracts/types";
import {
  InboxAdminService,
  InboxPrivilegedAdminService,
} from "./inbox-admin.service";
import { resolveOptions } from "./internal/options";
import { normalizeEnvelope } from "./internal/validation";
import { PrismaInboxStorage } from "./storage/prisma/prisma-inbox.storage";
import { InboxWorker } from "./worker/inbox-worker";

export class InboxService implements OnModuleInit, OnModuleDestroy {
  private readonly storage: PrismaInboxStorage;
  private readonly worker: InboxWorker;
  private readonly consumers: string[];
  private initialization?: Promise<void>;
  private closed = false;
  readonly admin: InboxAdminService;
  readonly privilegedAdmin?: InboxPrivilegedAdminService;

  constructor(private readonly options: InboxOptions) {
    const resolved = resolveOptions(options);
    this.consumers = resolved.consumers;
    this.storage = new PrismaInboxStorage(options.prisma, {
      maxPendingMessages: options.maxPendingMessages,
    });
    this.worker = new InboxWorker(
      this.storage,
      options.handlers ?? [],
      resolved.worker,
      options.observer,
      options.handlerContext,
    );
    this.admin = new InboxAdminService(this.storage);
    if (options.privilegedAdmin)
      this.privilegedAdmin = new InboxPrivilegedAdminService(this.storage);
  }
  async onModuleInit(): Promise<void> {
    await this.initialize();
  }
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
  initialize(): Promise<void> {
    if (this.closed)
      return Promise.reject(
        new InboxError("CLOSED", "The inbox service is closed."),
      );
    this.initialization ??= this.storage.assertSchema().then(() => {
      if (!this.closed) this.worker.start();
    });
    return this.initialization;
  }
  async accept(envelope: InboxEnvelope) {
    const normalized = normalizeEnvelope(
      envelope,
      this.consumers,
      this.options.maxPayloadBytes,
    );
    await this.initialize();
    if (this.closed)
      throw new InboxError("CLOSED", "The inbox service is closed.");
    const receipt = await this.storage.accept(normalized);
    this.observe({ type: receipt.kind, consumer: normalized.consumer });
    return receipt;
  }
  /** Explicit bounded processing for managed workers and tests; automatic polling is optional. */
  async runOnce(): Promise<number> {
    await this.initialize();
    return this.worker.tick();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.worker.stop();
  }
  private observe(event: InboxObservation): void {
    try {
      void Promise.resolve(this.options.observer?.(event)).catch(
        () => undefined,
      );
    } catch {
      /* Observation cannot change committed data. */
    }
  }
}
