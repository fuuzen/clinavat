import { api, ApiError } from "../../api";

// The Hub and every proxy in front of it accept 1 MiB request bodies, so files are sent in chunks of this size.
const chunkBytes = 1024 * 1024;

export interface WrittenFile {
  path: string;
  size: number;
  mtime: number;
  etag: string;
}

/** `create` refuses to replace an existing file; an entity tag replaces the file only while it still has that version. */
export type WritePrecondition = "create" | { etag: string };

export interface WriteOptions {
  precondition?: WritePrecondition;
  signal?: AbortSignal;
  onProgress?: (sentBytes: number) => void;
}

export function isPreconditionFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 412;
}

// crypto.randomUUID only exists in secure contexts, and the site may be served over plain HTTP on a LAN.
function transferId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sendChunk(path: string, body: Blob, headers: Record<string, string>, signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api<{ received: number; file?: WrittenFile }>(path, { method: "PUT", body, headers, signal });
    } catch (error) {
      // The Hub rewrites a chunk from its offset, so resending one after a dropped connection is safe.
      const retryable = error instanceof ApiError ? error.status === 429 || error.status === 503 : error instanceof TypeError && !signal?.aborted;
      if (!retryable || attempt >= 4) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, attempt * 1500));
    }
  }
}

export async function writeWorkspaceFile(projectId: string, path: string, data: Blob, options: WriteOptions = {}): Promise<WrittenFile> {
  const transfer = transferId();
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (options.precondition === "create") headers["If-None-Match"] = "*";
  else if (options.precondition) headers["If-Match"] = options.precondition.etag;
  try {
    for (let offset = 0; ; offset += chunkBytes) {
      const query = new URLSearchParams({ path, offset: String(offset), size: String(data.size) });
      const result = await sendChunk(`/projects/${projectId}/transfers/${transfer}?${query}`, data.slice(offset, offset + chunkBytes), headers, options.signal);
      options.onProgress?.(result.received);
      if (result.file) return result.file;
    }
  } catch (error) {
    // Otherwise the chunks already staged on the Hub are only swept after an hour.
    if (data.size > chunkBytes) void api(`/projects/${projectId}/transfers/${transfer}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
