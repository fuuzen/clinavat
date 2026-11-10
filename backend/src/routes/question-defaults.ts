import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth.js';
import type { Context } from '../context.js';
import { questionPolicySchema, questionPreferenceSchema } from '../question-defaults.js';

/** Defaults for questions nobody answers in time: the site's, and each user's own for their conversations. */
export function questionDefaultsRoutes(app: FastifyInstance, context: Context) {
  const { questionDefaults, store, events } = context;
  const view = (userId: string) => ({ site: questionDefaults.site(), user: questionDefaults.user(userId) });
  app.get('/api/settings/questions', async request => view(request.user.id));
  app.put('/api/settings/questions', async request => {
    questionDefaults.updateUser(request.user.id, questionPreferenceSchema.parse(request.body));
    events.broadcast(request.user.id, { type: 'question-defaults', payload: {} });
    return view(request.user.id);
  });
  app.get('/api/admin/settings/questions', async request => {
    requireAdmin(request);
    return questionDefaults.site();
  });
  app.put('/api/admin/settings/questions', async request => {
    requireAdmin(request);
    const saved = questionDefaults.updateSite(questionPolicySchema.parse(request.body));
    for (const user of store.all<{ id: string }>('SELECT id FROM users')) {
      events.broadcast(user.id, { type: 'question-defaults', payload: {} });
    }
    return saved;
  });
}
