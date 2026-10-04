import { NextResponse, type NextRequest } from "next/server";

// /?k=<DEMO_KEY> pose le cookie demo_key puis retire k de l'URL.
export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  const key = url.searchParams.get("k");
  url.searchParams.delete("k");
  const response = NextResponse.redirect(url);
  if (process.env.DEMO_KEY && key === process.env.DEMO_KEY) {
    response.cookies.set("demo_key", key, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  return response;
}

// Pages seulement (ni API, ni /_next, ni fichiers statiques), et seulement si ?k= est présent.
export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|.*\\.\\w+$).*)",
      has: [{ type: "query", key: "k" }],
    },
  ],
};
