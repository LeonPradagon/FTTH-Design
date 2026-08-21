import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

async function proxy(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const pathAndQuery = url.pathname
      .replace(/^\/api\/proxy\/?/, '')
      .replace(/^\/+/, '') + url.search;
    
    // Forward request to the Python server. Docker Compose provides the
    // internal service URL; local development falls back to localhost.
    const serverBaseUrl = (process.env.FTTH_SERVER_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
    const serverUrl = `${serverBaseUrl}/${pathAndQuery}`;
    
    // Extract better-auth session token
    let sessionToken;
    try {
      const cookieStore = await cookies();
      sessionToken = cookieStore.get('better-auth.session_token')?.value;
    } catch (e) {
      console.warn('Failed to read cookies', e);
    }
    
    const headers = new Headers(req.headers);
    headers.delete('host'); // Avoid host mismatch
    headers.delete('connection');
    
    if (sessionToken) {
      // Determine if it's a signed opaque token (split by .) or full JWT
      const parts = sessionToken.split('.');
      const token = parts.length === 3 ? sessionToken : parts[0];
      headers.set('Authorization', `Bearer ${token}`);
    }

    let reqBody;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        reqBody = await req.arrayBuffer();
      } catch (e) {
        console.warn('Failed to read request body', e);
      }
    }

    const res = await fetch(serverUrl, {
      method: req.method,
      headers: headers,
      body: reqBody
    } as RequestInit);
    
    // Create new headers from the server response
    const resHeaders = new Headers(res.headers);
    // Remove headers that might cause issues when proxying
    resHeaders.delete('content-encoding');
    resHeaders.delete('content-length');

    return new NextResponse(res.body, {
      status: res.status,
      headers: resHeaders
    });
  } catch (error: unknown) {
    console.error("Proxy error:", error);
    return NextResponse.json({ 
      error: "Internal Server Error", 
      details: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
