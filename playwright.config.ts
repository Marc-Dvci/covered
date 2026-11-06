import { defineConfig } from "@playwright/test";

// Runs the built app on an in-memory database, with no PayPal or model keys: the deterministic demo.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://localhost:8788", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "node --no-warnings --import tsx server/main.ts",
    url: "http://localhost:8788/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: "8788", COVERED_DB_FILE: "memory", GEMINI_API_KEY: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", COVERED_PUBLIC_URL: "http://localhost:8788" },
  },
});
