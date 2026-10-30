import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './database.js';
import { HttpError } from './models.js';

function validPublicOrigin(value: string): boolean {
  try {
    if (!/^https?:\/\/[^/?#\\@\s*]+\/?$/i.test(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !decodeURIComponent(url.hostname).includes('*')
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

export const publicUrlsSchema = z.array(z.string().trim().min(1).max(2048).refine(validPublicOrigin, {
  message: '必须是完整的 HTTP(S) Origin，不能包含通配符、账号密码、路径、查询参数或片段',
})).max(100).transform(values => [...new Set(values.map(value => new URL(value).origin))]);

interface SiteAccessRow { public_urls: string; revision: number }
export interface SiteAccessView { publicUrls: string[]; localOrigins: string[]; revision: number }

function migrationPublicUrls(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  const groups = value.split(',');
  if (groups.some(group => !group.trim())) throw new Error('CLINAVAT_ORIGIN 不能为空，且逗号分隔的地址不能包含空项');
  try { return publicUrlsSchema.parse(groups.flatMap(group => group.trim().split(/\s+/))); }
  catch (cause) { throw new Error('CLINAVAT_ORIGIN 首次迁移失败，请检查完整的 HTTP(S) Origin 地址列表', { cause }); }
}

export class SiteAccess {
  private readonly localOrigins: string[];

  constructor(private readonly store: Store, config: Config) {
    const ports = [...new Set([config.port, config.webPort, ...(config.vitePort ? [config.vitePort] : [])])];
    this.localOrigins = [...new Set(['localhost', '127.0.0.1']
      .flatMap(host => ports.map(port => new URL(`http://${host}:${port}`).origin)))];
    this.store.transaction(() => {
      // An empty saved list is intentional; the old environment is only a first-run seed.
      if (!this.store.get('SELECT id FROM site_access WHERE id=1')) {
        const publicUrls = migrationPublicUrls(config.initialPublicOrigins);
        this.store.run('INSERT OR IGNORE INTO site_access(id,public_urls,revision) VALUES(1,?,0)', JSON.stringify(publicUrls));
      }
      this.read();
    });
  }

  private read(): { publicUrls: string[]; revision: number } {
    const row = this.store.get<SiteAccessRow>('SELECT public_urls,revision FROM site_access WHERE id=1');
    if (!row) throw new Error('缺少站点来源配置');
    try {
      if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('invalid revision');
      return { publicUrls: publicUrlsSchema.parse(JSON.parse(row.public_urls)), revision: row.revision };
    } catch (cause) { throw new Error('站点来源配置损坏，拒绝使用空名单替代', { cause }); }
  }

  view(): SiteAccessView {
    return { ...this.read(), localOrigins: [...this.localOrigins] };
  }

  allows(origin: string): boolean {
    const { publicUrls } = this.read();
    return this.localOrigins.includes(origin) || publicUrls.includes(origin);
  }

  update(publicUrls: string[], expectedRevision: number): SiteAccessView {
    const normalized = publicUrlsSchema.parse(publicUrls);
    return this.store.transaction(() => {
      const result = this.store.run('UPDATE site_access SET public_urls=?,revision=revision+1 WHERE id=1 AND revision=?',
        JSON.stringify(normalized), expectedRevision);
      if (result.changes !== 1) throw new HttpError(409, '站点访问地址已被其他管理员修改，请刷新后重试');
      return this.view();
    });
  }
}
