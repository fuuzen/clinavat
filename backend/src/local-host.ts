import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import type { Store } from './database.js';
import { HttpError, type Host, type User } from './models.js';

function localHostId(userId: string): string {
  const namespace = Buffer.from('59072e5052b04951a819a4b3bea01397', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`local-host:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function ensureLocalHost(store: Store, userId: string): Host {
  const user = store.get<User>('SELECT * FROM users WHERE id=?', userId);
  if (user?.role !== 'admin') throw new HttpError(403, '仅管理员可使用本机开发机');
  const id = localHostId(userId);
  store.run(`INSERT INTO dev_hosts(id,user_id,name,host,port,username,status,kind)
    VALUES(?,?,'本机开发机','localhost',22,?,'CONNECTED','local')
    ON CONFLICT(id) DO UPDATE SET name='本机开发机',status='CONNECTED'`, id, userId, userInfo().username);
  return store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', id)!;
}
