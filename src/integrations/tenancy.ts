import {
  InboxConfigurationError,
  InboxPermanentError,
} from "../contracts/errors";
import type { InboxContext } from "../contracts/types";
import { validateScope } from "../internal/validation";

export interface InboxTenancyOptions {
  /** Public TenancyContext methods; structural so the integration stays optional. */
  context: {
    run<T>(tenantId: string, callback: () => Promise<T>): Promise<T>;
  };
  /** Public TenancyService methods, supplied by the application's TenancyModule. */
  tenancy: {
    getDbSettingKey(): string;
    getCurrentTenantOrThrow(): string;
    withoutTenant<T>(callback: () => Promise<T>): Promise<T>;
  };
  /** Reject global messages by default. Shared work still obeys database RLS. */
  global?: "reject" | "shared";
}

/**
 * Bind @nestarc/tenancy context to the durable message scope and set the canonical
 * PostgreSQL setting on Inbox's existing transaction before running the handler.
 * Use the application's raw Prisma client for Inbox, not a tenancy extension.
 *
 * The application authenticates the scope before accept(), provisions RLS policies
 * using the same setting key, and runs handlers with a non-owner, non-BYPASSRLS
 * database role. This adapter neither installs policies nor grants authorization.
 */
export function createInboxTenancyContext(
  options: InboxTenancyOptions,
): (context: InboxContext, next: () => Promise<void>) => Promise<void> {
  if (
    !options ||
    typeof options.context?.run !== "function" ||
    typeof options.tenancy?.getDbSettingKey !== "function" ||
    typeof options.tenancy?.getCurrentTenantOrThrow !== "function" ||
    typeof options.tenancy?.withoutTenant !== "function" ||
    (options.global !== undefined &&
      options.global !== "reject" &&
      options.global !== "shared")
  ) {
    throw new InboxConfigurationError(
      "Provide valid tenancy context and service options.",
    );
  }
  const settingKey = options.tenancy.getDbSettingKey();
  // A canonical custom GUC is required; do not accept built-in session settings.
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(settingKey)
  ) {
    throw new InboxConfigurationError(
      "Tenancy requires a valid PostgreSQL custom setting key.",
    );
  }
  const global = options.global ?? "reject";

  return async (context, next) => {
    const scope = validateScope(context.scope);
    if (scope.kind === "global") {
      if (global !== "shared") {
        throw new InboxPermanentError(
          "This handler context requires a tenant-scoped message.",
          "TENANT_SCOPE_REQUIRED",
        );
      }
      await options.tenancy.withoutTenant(async () => {
        // An explicit shared path clears any inherited database tenant setting.
        // Empty context cannot satisfy the tenant RLS policy; this is no bypass.
        await context.tx.$queryRawUnsafe(
          "SELECT set_config($1, $2, true)",
          settingKey,
          "",
        );
        await next();
      });
      return;
    }

    await options.context.run(scope.id, async () => {
      const tenantId = options.tenancy.getCurrentTenantOrThrow();
      if (tenantId !== scope.id) {
        throw new InboxPermanentError(
          "The active tenant context does not match the durable message scope.",
          "TENANT_CONTEXT_MISMATCH",
        );
      }
      await context.tx.$queryRawUnsafe(
        "SELECT set_config($1, $2, true)",
        settingKey,
        tenantId,
      );
      await next();
    });
  };
}
