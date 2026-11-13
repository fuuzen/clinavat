/** An image attached in the composer, already small enough for one upload. */
export interface ComposerImage {
  id: string;
  name: string;
  blob: Blob;
  /** A data URL: the site's content security policy does not allow blob URLs for images. */
  url: string;
}

export const maxComposerImages = 8;
const acceptedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// The reverse proxies take at most 1 MiB per request.
const uploadLimit = 1_000_000;
// Both CLIs scale larger images down anyway; at this size text in a screenshot stays legible.
const maxEdge = 2000;
let attachedCount = 0;

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Re-encodes the image until it fits one upload, trying lossless first for screenshots, then shrinking it. */
async function fit(bitmap: ImageBitmap, lossless: boolean): Promise<Blob> {
  let edge = Math.min(maxEdge, Math.max(bitmap.width, bitmap.height));
  while (edge >= 320) {
    const scale = edge / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) break;
    // JPEG has no transparency; a white ground keeps transparent areas from turning black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const attempts: [string, number?][] = [...(lossless ? [["image/png"] as [string]] : []),
      ["image/webp", 0.9], ["image/jpeg", 0.88], ["image/jpeg", 0.75]];
    for (const [type, quality] of attempts) {
      const blob = await encode(canvas, type, quality);
      // A browser that cannot encode the type falls back to PNG.
      if (blob && blob.type === type && blob.size <= uploadLimit) return blob;
    }
    edge = Math.floor(edge * 0.75);
  }
  throw new Error("图片过大，无法压缩到可上传的大小");
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

export async function prepareImage(file: File): Promise<ComposerImage> {
  const name = file.name || "粘贴的图片";
  if (!file.type.startsWith("image/")) throw new Error(`${name} 不是图片`);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error(`无法读取图片 ${name}，请改用 PNG、JPEG、GIF 或 WebP`); }
  try {
    const fits = acceptedTypes.includes(file.type) && file.size <= uploadLimit && Math.max(bitmap.width, bitmap.height) <= maxEdge;
    const blob = fits ? file : await fit(bitmap, file.type === "image/png" || file.type === "image/gif");
    return { id: `image-${++attachedCount}`, name, blob, url: await dataUrl(blob) };
  } finally {
    bitmap.close();
  }
}

/** The image IDs a stored message lists. */
export function messageImageIds(images: string | null | undefined): string[] {
  if (!images) return [];
  try {
    const ids: unknown = JSON.parse(images);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
