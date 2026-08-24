import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // Better-Auth sets a session cookie (better-auth.session_token) when using JWT plugin
  const sessionCookie =
    request.cookies.get("better-auth.session_token")
    || request.cookies.get("__Secure-better-auth.session_token");

  if (!sessionCookie && request.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login"],
};
