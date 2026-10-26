import type { Store } from './database.js';

export class ConnectionRegistry {
  private connections = new Map<string, Set<() => void>>();
  private resources = new Map<string, Set<() => void>>();
  private timer: NodeJS.Timeout;
  constructor(private store: Store) {
    this.timer = setInterval(() => {
      for (const hash of this.connections.keys()) {
        if (!this.store.get('SELECT token_hash FROM auth_sessions WHERE token_hash=? AND expires_at>?', hash, Date.now())) this.revoke(hash);
      }
    }, 15000);
    this.timer.unref();
  }
  watch(hash: string, close: () => void): () => void {
    if (!this.store.get('SELECT token_hash FROM auth_sessions WHERE token_hash=? AND expires_at>?', hash, Date.now())) {
      close(); return () => {};
    }
    const connections = this.connections.get(hash) ?? new Set<() => void>();
    connections.add(close);
    this.connections.set(hash, connections);
    return () => {
      connections.delete(close);
      if (!connections.size) this.connections.delete(hash);
    };
  }
  revoke(hash: string) {
    const connections = this.connections.get(hash);
    this.connections.delete(hash);
    for (const close of connections ?? []) close();
  }
  watchResource(resource: string, close: () => void): () => void {
    const connections = this.resources.get(resource) ?? new Set<() => void>();
    connections.add(close);
    this.resources.set(resource, connections);
    return () => {
      connections.delete(close);
      if (!connections.size) this.resources.delete(resource);
    };
  }
  revokeResource(resource: string) {
    const connections = this.resources.get(resource);
    this.resources.delete(resource);
    for (const close of connections ?? []) close();
  }
  close() {
    clearInterval(this.timer);
    for (const hash of this.connections.keys()) this.revoke(hash);
    for (const resource of this.resources.keys()) this.revokeResource(resource);
  }
}
