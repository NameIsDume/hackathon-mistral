import { timingSafeEqual } from "node:crypto";

// Garde des routes d'écriture : null si le cookie demo_key est valide, sinon 401.
// DEMO_KEY absente : tout est refusé.
export function requireDemoKey(request: Request): Response | null {
  const expected = process.env.DEMO_KEY;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("demo_key="))
    ?.slice("demo_key=".length);
  if (expected && cookie) {
    // Next encode la valeur du cookie ; on compare à la forme encodée (pas de decode qui pourrait lever).
    const a = Buffer.from(cookie);
    const b = Buffer.from(encodeURIComponent(expected));
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  return Response.json({ error: "demo_key manquante ou invalide" }, { status: 401 });
}
