import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recorded Mistral answers are read from disk on failure (lib/adapters/mistral.ts): ship them with the function.
  // The legal decisions are passed as data to the Q&A in Slack DMs (lib/services/conversation.ts).
  outputFileTracingIncludes: { "/api/intake": ["./fixtures/**/*"], "/api/slack/events": ["./docs/legal/**/*"] },
};

export default nextConfig;
