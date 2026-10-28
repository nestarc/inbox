import { Module } from "@nestjs/common";
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  Provider,
} from "@nestjs/common";
import type { InboxOptions } from "./contracts/types";
import {
  InboxAdminService,
  InboxPrivilegedAdminService,
} from "./inbox-admin.service";
import { InboxService } from "./inbox.service";

const INBOX_OPTIONS = Symbol("NESTARC_INBOX_OPTIONS");
export interface InboxModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  inject?: FactoryProvider["inject"];
  useFactory: (...dependencies: any[]) => InboxOptions | Promise<InboxOptions>;
  /** Explicit module-level opt-in is required to register the cross-tenant admin provider. */
  privilegedAdmin?: boolean;
}
@Module({})
export class InboxModule {
  static forRoot(options: InboxOptions): DynamicModule {
    return this.configure(
      { provide: INBOX_OPTIONS, useValue: options },
      [],
      options.privilegedAdmin === true,
    );
  }
  static forRootAsync(options: InboxModuleAsyncOptions): DynamicModule {
    return this.configure(
      {
        provide: INBOX_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...dependencies: any[]) => ({
          ...(await options.useFactory(...dependencies)),
          privilegedAdmin: options.privilegedAdmin === true,
        }),
      },
      options.imports ?? [],
      options.privilegedAdmin === true,
    );
  }
  private static configure(
    options: Provider,
    imports: NonNullable<ModuleMetadata["imports"]>,
    privileged: boolean,
  ): DynamicModule {
    const providers: Provider[] = [
      options,
      {
        provide: InboxService,
        inject: [INBOX_OPTIONS],
        useFactory: (value: InboxOptions) => new InboxService(value),
      },
      {
        provide: InboxAdminService,
        inject: [InboxService],
        useFactory: (inbox: InboxService) => inbox.admin,
      },
    ];
    const exports: Array<
      | typeof InboxService
      | typeof InboxAdminService
      | typeof InboxPrivilegedAdminService
    > = [InboxService, InboxAdminService];
    if (privileged) {
      providers.push({
        provide: InboxPrivilegedAdminService,
        inject: [InboxService],
        useFactory: (inbox: InboxService) => inbox.privilegedAdmin!,
      });
      exports.push(InboxPrivilegedAdminService);
    }
    return { module: InboxModule, imports, providers, exports };
  }
}
