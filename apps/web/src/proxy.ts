import { NextResponse, type NextRequest } from 'next/server';
import { isLocalSqliteBackend, localApiSupported, localUnavailableResponse } from './lib/local-backend';

/** SQLite is a separately selected testing backend. Unimplemented API routes
 * are rejected before their PostgreSQL/provider handlers can execute. */
export function proxy(request: NextRequest) {
  try {
    if (isLocalSqliteBackend() && !localApiSupported(request.nextUrl.pathname, request.method)) return localUnavailableResponse();
  } catch {
    return localUnavailableResponse();
  }
  return NextResponse.next();
}
export const config = { matcher: '/api/:path*' };
