import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../models.js';
import { type Context, projectFor } from '../context.js';
import { FileTransfers, fileTag, transferFailure } from '../runtime/file-transfers.js';

const identifier = z.object({ id: z.uuid() });
const transferIdentifier = z.object({ id: z.uuid(), transfer: z.uuid() });
const filePath = z.string().min(1).max(4096);

// Only types the preview renderers consume are served with their real MIME type; everything else stays opaque.
const previewTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function contentDisposition(kind: 'inline' | 'attachment', path: string): string {
  const name = basename(path);
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first, last] = match;
  if (!first && !last) return 'invalid';
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(Number(last), size - 1) : size - 1;
  return start > end || start >= size ? 'invalid' : { start, end };
}

export function workspaceFileRoutes(app: FastifyInstance, context: Context) {
  const { workspaces } = context;
  const transfers = new FileTransfers(workspaces, context.config.uploadLimitBytes);
  app.get('/api/projects/:id/files', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: z.string().max(4096).default('') }).parse(request.query);
    return workspaces.files(projectFor(context, id, request.user.id), path);
  });
  app.get('/api/projects/:id/file', async request => {
    const { id } = identifier.parse(request.params);
    const { path } = z.object({ path: filePath }).parse(request.query);
    const file = await workspaces.file(projectFor(context, id, request.user.id), path);
    return { ...file, etag: fileTag(file) };
  });
  app.get('/api/projects/:id/raw', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const { path, download } = z.object({ path: filePath, download: z.enum(['1']).optional() }).parse(request.query);
    const { handle, size, mtime } = await workspaces.rawFile(projectFor(context, id, request.user.id), path)
      // Filesystem errors embed absolute server paths; only the workspace's own validation messages are passed through.
      .catch((error: NodeJS.ErrnoException) => { throw new HttpError(404, error.code ? '文件不存在或无法访问' : error.message); });
    const etag = fileTag({ size, mtime });
    const type = download ? 'application/octet-stream' : previewTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
    reply.header('Content-Type', type)
      .header('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', path))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-cache')
      .header('Accept-Ranges', 'bytes')
      .header('ETag', etag);
    // SVG may carry scripts; keep it inert even if opened directly rather than through <img>.
    if (type === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (request.headers['if-none-match'] === etag) { await handle.close(); return reply.code(304).send(); }
    const range = parseRange(request.headers.range, size);
    if (range === 'invalid') { await handle.close(); return reply.code(416).header('Content-Range', `bytes */${size}`).send(); }
    if (range) {
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1);
      return reply.send(handle.createReadStream(range));
    }
    reply.header('Content-Length', size);
    return reply.send(handle.createReadStream());
  });
  // Chunks arrive as raw bytes; the parser hands over the stream and the transfer enforces its own size limits.
  app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    // A large file is many 1 MiB chunks, which the site-wide request limit would throttle.
    scope.put('/api/projects/:id/transfers/:transfer', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (request, reply) => {
      const { id, transfer } = transferIdentifier.parse(request.params);
      const { path, offset, size } = z.object({
        path: filePath, offset: z.coerce.number().int().min(0), size: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }).parse(request.query);
      if (request.body !== undefined && !(request.body instanceof Readable)) throw new HttpError(415, '上传数据必须以 application/octet-stream 发送');
      const project = projectFor(context, id, request.user.id);
      const condition = { createOnly: request.headers['if-none-match'] === '*', expectedTag: request.headers['if-match'] };
      const result = await transfers.receive(project, { path, transfer, offset, size, condition }, request.body ?? [])
        .catch(error => { throw transferFailure(error); });
      if (result.file) reply.header('ETag', result.file.etag);
      return result;
    });
  });
  app.delete('/api/projects/:id/transfers/:transfer', async request => {
    const { id, transfer } = transferIdentifier.parse(request.params);
    await transfers.discard(projectFor(context, id, request.user.id), transfer);
    return { ok: true };
  });
}
