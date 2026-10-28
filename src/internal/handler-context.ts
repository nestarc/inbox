import { InboxConfigurationError } from "../contracts/errors";
import type {
  InboxContext,
  InboxHandlerContextRunner,
} from "../contracts/types";

/** A context wrapper cannot skip the handler, swallow its failure, or invoke it twice. */
export async function runInHandlerContext(
  context: InboxContext,
  handle: () => Promise<void>,
  runner?: InboxHandlerContextRunner,
): Promise<void> {
  context.signal.throwIfAborted();
  if (!runner) return handle();
  let invocation: Promise<void> | undefined;
  let invalid = false;
  let open = true;
  const next = (): Promise<void> => {
    context.signal.throwIfAborted();
    if (!open || invocation) {
      invalid = true;
      throw new InboxConfigurationError(
        "handlerContext must call next exactly once.",
      );
    }
    invocation = Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      return handle();
    });
    // Also observe immediately when a wrapper forgets to await or swallows rejection.
    void invocation.catch(() => undefined);
    return invocation;
  };
  try {
    await runner(context, next);
    if (!invocation)
      throw new InboxConfigurationError(
        "handlerContext must call next exactly once.",
      );
    await invocation;
    if (invalid)
      throw new InboxConfigurationError(
        "handlerContext must call next exactly once.",
      );
  } finally {
    open = false;
  }
}
