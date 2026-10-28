const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.INBOX_EXAMPLE_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "Set INBOX_EXAMPLE_DATABASE_URL to the dedicated local fixture.",
    );
  const url = new URL(connectionString);
  const isolatedTest =
    process.env.INBOX_TEST_DATABASE === "1" &&
    process.env.INBOX_TEST_DATABASE_URL === connectionString &&
    process.env.INBOX_TEST_DATABASE_NAME === url.pathname.slice(1) &&
    /^\/nestarc_inbox_test_[a-f0-9]{16}$/.test(url.pathname) &&
    url.username === "inbox_test";
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (!/^\/inbox_examples(?:_[a-zA-Z0-9_]+)?$/.test(url.pathname) &&
      !isolatedTest)
  ) {
    throw new Error(
      "Examples only prepare a local database named inbox_examples or inbox_examples_<suffix>.",
    );
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const path of [
      require.resolve("@nestarc/inbox/sql/create-inbox-table.sql"),
      require.resolve("@nestarc/outbox/src/sql/create-outbox-table.sql"),
      join(__dirname, "../sql/application.sql"),
    ]) {
      await client.query(readFileSync(path, "utf8"));
    }
    console.log("Prepared the dedicated inbox example database.");
  } finally {
    await client.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
