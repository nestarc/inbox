const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { resolve } = require("node:path");

if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  !process.env.INBOX_TEST_DATABASE_URL
) {
  throw new Error(
    "Run through scripts/with-test-db.mjs so only a disposable database is used.",
  );
}
const env = {
  ...process.env,
  INBOX_EXAMPLE_DATABASE_URL: process.env.INBOX_TEST_DATABASE_URL,
  INBOX_EXAMPLE_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
};
const steps = [
  "generate",
  "build",
  "db:prepare",
  "outbox",
  "webhook",
  "tenancy",
  "idempotency",
];
if (process.argv.includes("--rabbitmq")) steps.push("rabbitmq");
if (process.argv.includes("--brokers")) steps.push("kafka", "sqs", "bullmq");
for (const step of steps) {
  const result = spawnSync("npm", ["run", step], {
    cwd: resolve(__dirname, ".."),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
