import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/adapters/supabase", async (orig) => {
  const real = await orig<typeof import("@/lib/adapters/supabase")>();
  return {
    ...real,
    loadSnapshot: async (id: string) => {
      throw new real.IncidentNotFound(id);
    },
    listEvents: async () => [],
  };
});

const { POST } = await import("@/app/api/draft/route");

describe("POST /api/draft", () => {
  it("answers 404 for an unknown incident", async () => {
    vi.stubEnv("DEMO_KEY", "k");
    const res = await POST(
      new Request("http://localhost/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "demo_key=k" },
        body: JSON.stringify({ incidentId: "00000000-0000-4000-8000-000000000000", document: "breach_register" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
