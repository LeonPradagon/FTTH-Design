import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const maxDuration = 900;

const BACKEND_ORIGIN = process.env.BACKEND_URL || "http://127.0.0.1:8000";
const PROXY_TIMEOUT_MS = 15 * 60 * 1000;

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

    const cookieStore = await cookies();
    const sessionToken = (
      cookieStore.get('better-auth.session_token')
      || cookieStore.get('__Secure-better-auth.session_token')
    )?.value;
    
    const headers = new Headers(req.headers);
    headers.delete('host'); // Avoid host mismatch
    headers.delete('connection');
    
    if (sessionToken) {
      // Determine if it's a signed opaque token (split by .) or full JWT
      const parts = sessionToken.split('.');
      const token = parts.length === 3 ? sessionToken : parts[0];
      headers.set('Authorization', `Bearer ${token}`);
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
