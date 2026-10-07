export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export async function readLimited(response: Response | Request, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, "Body is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Body is too large");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function jsonBody(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  let value: unknown;
  try { value = JSON.parse(await readLimited(request, maxBytes)); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function textField(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return value;
}

export async function secretsEqual(candidate: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected || !candidate || candidate.length > 1024) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i]! ^ bb[i]!;
  return difference === 0;
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  // Provider responses, message bodies and credentials must never reach logs.
  console.error("Agent request failed", { errorType: error instanceof Error ? error.name : "unknown" });
  return Response.json({ error: "Internal agent error" }, { status: 500 });
}
