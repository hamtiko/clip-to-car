import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Runs the whole suite inside the Workers runtime (Miniflare) so the API tests
// hit the real Worker via SELF, and crypto/maplink tests run against the same
// WebCrypto/URL globals the browser and Worker use. `pretest` (npm) runs
// build.mjs first so src/generated/pages.js exists for the Worker to import.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // TOKEN is a Worker secret in production (`wrangler secret put TOKEN`);
        // inject a known value for tests.
        bindings: { TOKEN: "test-token-123" },
      },
    }),
  ],
});
