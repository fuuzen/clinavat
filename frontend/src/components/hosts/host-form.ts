import type { SshEndpoint } from "./EndpointFields";

export function hostPayload(
  form: HTMLFormElement,
  target: SshEndpoint,
  jump: SshEndpoint | null,
) {
  const data = new FormData(form);
  const privateKey = String(data.get("privateKey") || "").trim();
  const jumpPrivateKey = String(data.get("jumpPrivateKey") || "").trim();
  return {
    name: String(data.get("name") || "").trim(),
    ...target,
    host: target.host.trim(),
    username: target.username.trim(),
    ...(privateKey ? { privateKey } : {}),
    jumpHost: jump ? {
      ...jump,
      host: jump.host.trim(),
      username: jump.username.trim(),
      ...(jumpPrivateKey ? { privateKey: jumpPrivateKey } : {}),
    } : null,
  };
}
