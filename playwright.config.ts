import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000" },
  webServer: process.env.BASE_URL ? undefined : { command: "pnpm dev", port: 3000, reuseExistingServer: true },
});
