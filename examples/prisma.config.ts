import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url:
      process.env.INBOX_EXAMPLE_DATABASE_URL ??
      "postgresql://example:example@127.0.0.1:55434/inbox_examples",
  },
});
