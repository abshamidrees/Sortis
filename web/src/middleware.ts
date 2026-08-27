import { NextRequest, NextResponse } from "next/server";

/**
 * Three hostnames, one Next app, one Vercel project.
 *
 * The brief lists sortis.xyz, app.sortis.xyz and docs.sortis.xyz as three
 * surfaces. Rather than three deployments that drift apart, this rewrites on
 * the Host header into three route groups. The URL the visitor sees stays
 * clean -- app.sortis.xyz/draw, not app.sortis.xyz/app/draw -- because a
 * rewrite changes what renders, not what is displayed.
 *
 * Local development has no subdomains, so every surface is also reachable by
 * path: localhost:3000/app/draw serves what app.sortis.xyz/draw serves. The
 * SURFACE env var pins a single surface when you want to work on one in
 * isolation.
 */

type Surface = "web" | "app" | "docs";

/** Host prefix to surface. Anything unmatched is the landing page. */
function surfaceForHost(host: string): Surface {
  const name = host.split(":")[0].toLowerCase();

  if (name.startsWith("app.")) return "app";
  if (name.startsWith("docs.")) return "docs";

  // Vercel preview deployments land on *.vercel.app with no subdomain to read,
  // so let an env var pin the surface there.
  const pinned = process.env.NEXT_PUBLIC_SURFACE as Surface | undefined;
  if (pinned === "app" || pinned === "docs") return pinned;

  return "web";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Already addressed by path. Leave it alone so localhost works without
  // subdomains and so the rewrite below cannot loop.
  if (pathname.startsWith("/app") || pathname.startsWith("/docs")) {
    return NextResponse.next();
  }

  const surface = surfaceForHost(request.headers.get("host") ?? "");
  if (surface === "web") return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = `/${surface}${pathname === "/" ? "" : pathname}`;

  const response = NextResponse.rewrite(url);
  // Handy when you are staring at a deployment wondering which surface you got.
  response.headers.set("x-sortis-surface", surface);
  return response;
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)"],
};
