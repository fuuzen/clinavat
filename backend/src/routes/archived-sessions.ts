import type { SQLInputValue } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { HttpError, type Session } from '../models.js';

export type ArchivedSessionKind = 'all' | 'primary' | 'child';

export interface ArchivedSessionItem extends Session {
  project_name: string;
  root_project_id: string;
}

export interface ArchivedSessionsResponse {
  items: ArchivedSessionItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const sessionIdParams = z.object({ id: z.uuid() });

function queryInt(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    value => (value === undefined || value === '' ? undefined : typeof value === 'string' ? value.trim() : value),
    z.union([
      z.number().int().min(min).max(max),
      z.string().regex(/^-?\d+$/, '必须为整数').transform(Number).pipe(z.number().int().min(min).max(max)),
    ]).default(defaultValue),
  );
}

const archivedSessionsQuery = z.object({
  page: queryInt(1, 1, 1_000_000),
  pageSize: queryInt(20, 1, 100),
  q: z.preprocess(
    value => (value === undefined ? undefined : typeof value === 'string' ? value.trim() : value),
    z.string().max(200).optional(),
  ).transform(value => (value ? value : undefined)),
  projectId: z.preprocess(
    value => (value === undefined || value === '' ? undefined : value),
    z.uuid().optional(),
  ),
  kind: z.preprocess(
    value => (value === undefined || value === '' ? undefined : value),
    z.enum(['all', 'primary', 'child']).default('all'),
  ),
});

/** Escapes SQLite LIKE wildcards (`\`, `%`, `_`) for use with `ESCAPE '\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\_%]/g, '\\$&');
}

const archivedSessionsFrom = `FROM sessions s
  JOIN projects p ON p.id = s.project_id
  LEFT JOIN projects pp ON pp.id = p.parent_project_id
  JOIN dev_hosts h ON h.id = p.dev_host_id`;

/**
 * Registers archived-session search/pagination and single-session lookup routes.
 * `GET /api/sessions/archived` is registered before `GET /api/sessions/:id` so `"archived"` is never captured by `:id`.
 */
export function archivedSessionRoutes(app: FastifyInstance, context: Context) {
  const { store } = context;

  app.get('/api/sessions/archived', async (request): Promise<ArchivedSessionsResponse> => {
    const query = archivedSessionsQuery.parse(request.query);
    const conditions: string[] = [
      's.user_id = ?',
      's.archived_at IS NOT NULL',
      "(h.kind IN ('ssh','client') OR ? = 'admin')",
    ];
    const params: SQLInputValue[] = [request.user.id, request.user.role];

    if (query.projectId) {
      conditions.push('(s.project_id = ? OR p.parent_project_id = ?)');
      params.push(query.projectId, query.projectId);
    }

    if (query.kind === 'primary') {
      conditions.push('(s.parent_session_id IS NULL AND s.discussion_id IS NULL AND s.agent_name IS NULL)');
    } else if (query.kind === 'child') {
      conditions.push('(s.parent_session_id IS NOT NULL OR s.discussion_id IS NOT NULL OR s.agent_name IS NOT NULL)');
    }

    if (query.q) {
      const pattern = `%${escapeLikePattern(query.q.toLowerCase())}%`;
      const matchers = [
        "lower(s.title) LIKE ? ESCAPE '\\'",
        "lower(p.name) LIKE ? ESCAPE '\\'",
        "lower(pp.name) LIKE ? ESCAPE '\\'",
        "lower(s.agent_name) LIKE ? ESCAPE '\\'",
        "lower(s.agent_profile) LIKE ? ESCAPE '\\'",
        "lower(s.agent_instructions) LIKE ? ESCAPE '\\'",
        "lower(s.discussion_stance) LIKE ? ESCAPE '\\'",
        "EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND lower(m.content) LIKE ? ESCAPE '\\')",
      ];
      conditions.push(`(${matchers.join(' OR ')})`);
      for (let i = 0; i < matchers.length; i += 1) params.push(pattern);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const total = store.get<{ count: number }>(
      `SELECT COUNT(*) AS count ${archivedSessionsFrom} ${whereClause}`,
      ...params,
    )?.count ?? 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / query.pageSize);
    const offset = (query.page - 1) * query.pageSize;

    const items = total > 0
      ? store.all<ArchivedSessionItem>(
        `SELECT s.*, COALESCE(pp.name, p.name) AS project_name, COALESCE(p.parent_project_id, p.id) AS root_project_id
         ${archivedSessionsFrom} ${whereClause}
         ORDER BY s.archived_at DESC, s.updated_at DESC, s.id DESC
         LIMIT ? OFFSET ?`,
        ...params,
        query.pageSize,
        offset,
      )
      : [];

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
    };
  });

  app.get('/api/sessions/:id', async request => {
    const { id } = sessionIdParams.parse(request.params);
    const session = store.get<Session>(
      `SELECT s.* FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN dev_hosts h ON h.id = p.dev_host_id
       WHERE s.id = ? AND s.user_id = ? AND (h.kind IN ('ssh','client') OR ? = 'admin')`,
      id,
      request.user.id,
      request.user.role,
    );
    if (!session) throw new HttpError(404, '对话不存在');
    return { session };
  });
}
