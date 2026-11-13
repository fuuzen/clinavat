import { randomUUID } from 'node:crypto';
import type { Store } from './database.js';
import { HttpError } from './models.js';
import type { PromptImage } from './agent/types.js';

// Recognized by their leading bytes: the browser's declared type is only a claim.
const signatures: Record<string, (data: Buffer) => boolean> = {
  'image/png': data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  'image/gif': data => ['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6)),
  'image/webp': data => data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP',
};

/** The formats both CLIs accept. */
export const imageTypes = Object.keys(signatures);
export const maxImagesPerMessage = 8;

export function saveImage(store: Store, sessionId: string, mediaType: string, data: Buffer): string {
  if (!signatures[mediaType]?.(data)) throw new HttpError(400, '图片内容与格式不符，仅支持 PNG、JPEG、GIF 和 WebP');
  const id = randomUUID();
  store.run('INSERT INTO message_images(id,session_id,media_type,data) VALUES(?,?,?,?)', id, sessionId, mediaType, data);
  return id;
}

/** The images of a new message, which must all have been uploaded to its conversation, without repeats. */
export function messageImages(store: Store, sessionId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!store.get('SELECT id FROM message_images WHERE id=? AND session_id=?', id, sessionId)) {
      throw new HttpError(409, '图片已失效，请重新添加后发送');
    }
  }
  return unique;
}

export const storedImages = (ids: string[]): string | null => ids.length ? JSON.stringify(ids) : null;

export function loadImages(store: Store, sessionId: string, ids: string[]): PromptImage[] {
  return ids.map(id => {
    const image = readImage(store, sessionId, id);
    if (!image) throw new Error('消息附带的图片已被删除，请重新发送');
    return { mediaType: image.media_type, data: Buffer.from(image.data).toString('base64') };
  });
}

export function readImage(store: Store, sessionId: string, id: string) {
  return store.get<{ media_type: string; data: Uint8Array }>(
    'SELECT media_type,data FROM message_images WHERE id=? AND session_id=?', id, sessionId);
}

/** Copies a message's images into another conversation, which then owns its own copies; returns the stored list. */
export function copyImages(store: Store, images: string | null, targetSessionId: string): string | null {
  if (!images) return null;
  const copies = (JSON.parse(images) as string[]).flatMap(id => {
    const copy = randomUUID();
    return store.run(`INSERT INTO message_images(id,session_id,media_type,data,created_at)
      SELECT ?,?,media_type,data,created_at FROM message_images WHERE id=?`, copy, targetSessionId, id).changes ? [copy] : [];
  });
  return storedImages(copies);
}
