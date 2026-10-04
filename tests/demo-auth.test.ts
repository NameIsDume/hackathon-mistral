import { afterEach, describe, expect, it, vi } from "vitest";
import { requireDemoKey } from "@/lib/demo-auth";

const req = (cookie?: string) =>
  new Request("http://localhost/api/intake", cookie ? { headers: { cookie } } : {});

describe("requireDemoKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuse sans cookie", () => {
    vi.stubEnv("DEMO_KEY", "secret");
    expect(requireDemoKey(req())?.status).toBe(401);
  });
  it("refuse une mauvaise clé", () => {
    vi.stubEnv("DEMO_KEY", "secret");
    expect(requireDemoKey(req("demo_key=secreT"))?.status).toBe(401);
    expect(requireDemoKey(req("demo_key=secret2"))?.status).toBe(401);
  });
  it("accepte la bonne clé", () => {
    vi.stubEnv("DEMO_KEY", "secret");
    expect(requireDemoKey(req("theme=dark; demo_key=secret"))).toBeNull();
  });
  it("refuse tout si DEMO_KEY n'est pas définie", () => {
    vi.stubEnv("DEMO_KEY", undefined);
    expect(requireDemoKey(req("demo_key="))?.status).toBe(401);
    expect(requireDemoKey(req("demo_key=undefined"))?.status).toBe(401);
  });
});
