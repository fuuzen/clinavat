import { HttpResponse } from "msw";

export function fail(status: number, message: string) {
  return HttpResponse.json({ message }, { status });
}

export function unavailable(action: string) {
  return fail(403, `在线预览中无法${action}，请部署完整版本后体验。`);
}

export function ok() {
  return HttpResponse.json({ ok: true });
}

export async function readBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}
