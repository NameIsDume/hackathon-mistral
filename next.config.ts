import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recorded Mistral answers are read from disk on failure (lib/adapters/mistral.ts): ship them with the function.
  // The lawyer's memo (lib/services/memo.ts) quotes and checks citations against docs/legal.
  outputFileTracingIncludes: { "/api/intake": ["./fixtures/**/*"], "/api/slack/interactions": ["./docs/legal/**/*"] },
};

export default nextConfig;
