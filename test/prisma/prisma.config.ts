import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./schema.prisma",
  // Generation and typechecking need no database. Real tests supply the guarded fixture URL.
  datasource: {
    url:
      process.env.INBOX_TEST_DATABASE_URL ??
      "postgresql://unused:unused@127.0.0.1:1/inbox_generation_only",
  },
});
