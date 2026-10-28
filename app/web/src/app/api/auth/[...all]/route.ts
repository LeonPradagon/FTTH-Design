import type { NextRequest } from 'next/server';

const GEOSPATIAL_AUTH_ORIGIN = process.env.GEOSPATIAL_AUTH_URL || 'http://localhost:3000';

async function forwardAuth(request: NextRequest) {
  const incoming = new URL(request.url);
  const upstream = new URL(`${incoming.pathname}${incoming.search}`, GEOSPATIAL_AUTH_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    cache: 'no-store',
    redirect: 'manual',
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const GET = forwardAuth;
export const POST = forwardAuth;
