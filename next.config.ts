import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recorded Mistral answers are read from disk on failure (lib/adapters/mistral.ts): ship them with the function.
  outputFileTracingIncludes: { "/api/intake": ["./fixtures/**/*"] },
};

export default nextConfig;
