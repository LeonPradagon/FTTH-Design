import { NextRequest, NextResponse } from "next/server";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 900;

const BACKEND_ORIGIN = process.env.BACKEND_URL || "http://127.0.0.1:8000";
const PROXY_TIMEOUT_MS = 15 * 60 * 1000;
// Keep local development compatible with installations that only configured
// BETTER_AUTH_SECRET. Production should still use a dedicated secret.
const BACKEND_PROXY_SECRET = process.env.BACKEND_PROXY_SECRET || process.env.BETTER_AUTH_SECRET;

function requestBackend(
  backendUrl: URL,
  method: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const backendRequest = httpRequest(backendUrl, {
      method,
      headers: Object.fromEntries(headers.entries()),
    });

    const abortRequest = () => backendRequest.destroy(new Error("Client request aborted"));
    signal.addEventListener("abort", abortRequest, { once: true });

    backendRequest.setTimeout(PROXY_TIMEOUT_MS, () => {
      const timeoutError = new Error("Backend generation exceeded 15 minutes") as NodeJS.ErrnoException;
      timeoutError.code = "ETIMEDOUT";
      backendRequest.destroy(timeoutError);
    });

    backendRequest.once("response", (response) => {
      signal.removeEventListener("abort", abortRequest);
      resolve(response);
    });
    backendRequest.once("error", (error) => {
      signal.removeEventListener("abort", abortRequest);
      reject(error);
    });

    if (body && body.byteLength > 0) {
      backendRequest.write(Buffer.from(body));
    }
    backendRequest.end();
  });
}

async function proxy(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const pathAndQuery = url.pathname.replace(/^\/api\/proxy\/?/, '') + url.search;
    const backendUrl = new URL(pathAndQuery, `${BACKEND_ORIGIN.replace(/\/$/, "")}/`);

    const headers = new Headers(req.headers);
    headers.delete('host'); // Avoid host mismatch
    headers.delete('connection');
    // These are service-authenticated headers. Never trust values supplied by
    // a browser directly, even when the request is going through this route.
    headers.delete('x-user-id');
    headers.delete('x-user-role');
    headers.delete('x-user-email');
    headers.delete('x-proxy-auth');
    
    // Resolve the session in-process. Calling /api/auth/get-session over HTTP
    // can lose the cookie behind a reverse proxy or when the public host is
    // not reachable from the Next.js server itself.
    if (req.headers.get('cookie')) {
      try {
        const sessionData = await auth.api.getSession({ headers: req.headers });
        if (sessionData?.user) {
          const userId = String(sessionData.user.id);
          const role = String(sessionData.user.role || 'engineer');
          const email = String(sessionData.user.email || '');
          headers.set('X-User-Id', userId);
          headers.set('X-User-Role', role);
          headers.set('X-User-Email', email);
          if (BACKEND_PROXY_SECRET) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const payload = `${userId}|${timestamp}|${role}|${email}`;
            const signature = createHmac('sha256', BACKEND_PROXY_SECRET).update(payload).digest('hex');
            headers.set('X-Proxy-Auth', `${payload}|${signature}`);
          }
        } else {
          console.warn("Proxy request has cookies but no valid Better Auth session");
        }
      } catch (err) {
        console.error("Proxy session verification error:", err);
      }
    }

    const reqBody = req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await req.arrayBuffer();

    const res = await requestBackend(backendUrl, req.method, headers, reqBody, req.signal);

    const resHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (Array.isArray(value)) {
        value.forEach((item) => resHeaders.append(name, item));
      } else if (value !== undefined) {
        resHeaders.set(name, String(value));
      }
    }
    resHeaders.delete('content-encoding');
    resHeaders.delete('content-length');

    if (resHeaders.get('content-type')?.includes('text/event-stream')) {
      resHeaders.set('content-encoding', 'none');
    }

    const responseBody = Readable.toWeb(res) as ReadableStream<Uint8Array>;
    return new NextResponse(responseBody, {
      status: res.statusCode || 502,
      headers: resHeaders
    });
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    const isTimeout = code === 'ETIMEDOUT';
    console.error("Proxy error:", error);
    return NextResponse.json({ 
      error: isTimeout ? "Gateway Timeout" : "Internal Server Error",
      detail: isTimeout
        ? "Proses generate melewati batas waktu 15 menit. Coba gunakan boundary yang lebih kecil."
        : "Tidak dapat terhubung ke backend FTTH."
    }, { status: isTimeout ? 504 : 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
