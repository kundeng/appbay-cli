import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.APPBAY_DB_PATH ?? "./appbay.db",
  },
});
