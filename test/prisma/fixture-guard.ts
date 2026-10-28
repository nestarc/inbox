/** Refuse resets against arbitrary DATABASE_URL values, including local app DBs. */
export function requireTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    env.INBOX_TEST_DATABASE !== "1" ||
    !env.INBOX_TEST_DATABASE_URL ||
    env.DATABASE_URL !== env.INBOX_TEST_DATABASE_URL ||
    !/^nestarc_inbox_test_[0-9a-f]{16}$/.test(
      env.INBOX_TEST_DATABASE_NAME ?? "",
    )
  ) {
    throw new Error(
      "Use scripts/with-test-db.mjs to create an isolated test database.",
    );
  }
  const url = new URL(env.INBOX_TEST_DATABASE_URL);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username !== "inbox_test" ||
    url.pathname !== `/${env.INBOX_TEST_DATABASE_NAME}` ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Refusing to modify a database outside the loopback inbox fixture.",
    );
  }
  return url.toString();
}
