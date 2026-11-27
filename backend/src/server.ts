import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './config.js';
import { Store } from './database.js';
import { registerAuth } from './auth.js';
import { EventBus } from './events.js';
import { ConversationStore } from './conversation.js';
import { loadImages, storedImages } from './message-images.js';
import { ConnectionRegistry } from './connections.js';
import { SshManager } from './runtime/ssh.js';
import { SshTargetPolicy } from './runtime/target-policy.js';
import { DevHostApprovalStore } from './runtime/dev-host-approvals.js';
import { SshRelayServer } from './runtime/ssh-relay.js';
import { ClientHostRegistry } from './client-host/registry.js';
import { ClientSshServer } from './client-host/ssh-server.js';
import { clientDeviceRoutes } from './client-host/routes.js';
import { ClientWorkspaceAdapter } from './client-host/workspace-adapter.js';
import { ClientMirrorSync } from './client-host/mirror-sync.js';
import { ClientExecBarrier, type ClientExecBarrierReply, type ClientExecBarrierRequest } from './client-host/exec-barrier.js';
import { revokeSockets as revokeTerminalSockets } from './runtime/terminal.js';
import { WorkspaceManager } from './runtime/workspace.js';
import { MaintenanceService } from './runtime/maintenance.js';
import { registerMaintenanceGuard } from './runtime/maintenance-guard.js';
import { describeSkippedLinks, recordSkippedLinks } from './sync-links.js';
import { AgentManager } from './agent/manager.js';
import { BtwService } from './agent/btw/service.js';
import { resourceRoutes } from './routes/resources.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentModelRoutes } from './routes/agent-models.js';
import { SlotModelCatalogs } from './agent/model-catalog.js';
import { completionRoutes } from './routes/completions.js';
import { adminRoutes } from './routes/admin.js';
import { siteAccessRoutes } from './routes/site-access.js';
import { siteSettingsRoutes } from './routes/site-settings.js';
import { questionDefaultsRoutes } from './routes/question-defaults.js';
import { QuestionDefaults } from './question-defaults.js';
import { AgentDefaults } from './agent-defaults.js';
import { tokenUsageRoutes } from './routes/token-usage.js';
import { TokenUsageLedger } from './token-usage/ledger.js';
import { PriceBook } from './token-usage/price-book.js';
import { gatewayRoutes } from './routes/gateway.js';
import { GatewayClient } from './gateway/client.js';
import { GatewayService } from './gateway/service.js';
import { SiteAccess } from './site-access.js';
import { SiteSettingsService } from './site-settings.js';
import { HttpError, type Host, type Project, type Session } from './models.js';
import type { AgentContext, AgentEvent, AgentWorkspaceBridge, OrchestrationHost } from './agent/types.js';
import { Orchestrator } from './orchestration/service.js';
import { resetReviewsForUserMessage } from './orchestration/board.js';
import { OrchestrationSettingsStore } from './orchestration/limits.js';
import { WorktreeManager } from './orchestration/worktrees/index.js';
import { sessionAgentRoutes } from './routes/session-agents.js';
import { AccountCredentials } from './accounts/credentials.js';
import { SlotTokens } from './accounts/slot-tokens.js';
import { ensureClaudeSlotIdentity } from './accounts/claude-identity.js';
import { SlotUsage } from './accounts/usage.js';
import { UsageSettingsStore } from './accounts/usage-settings.js';
import { SlotSelector } from './accounts/selection.js';
import { prepareSlotFailover } from './accounts/failover.js';
import { slotForUser } from './accounts/access.js';
import { LxdExecutionHost } from './execution/lxd-host.js';
import { ProcessExecutionHost } from './execution/process-host.js';
import { MachinePlan } from './execution/machine-plan.js';
import { HostCommands } from './execution/host-commands.js';
import { MachineResourceSettingsStore, parseSize } from './execution/machine-resources.js';

let shuttingDown = false;
// Register SIGUSR2 before any async startup work so Node's default handler cannot terminate the Hub during startup.
let handleIdleReclaimSignal: () => void = () => undefined;
process.on('SIGUSR2', () => {
  if (shuttingDown) return;
  handleIdleReclaimSignal();
});

const app = Fastify({
  logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] },
  bodyLimit: 1024 * 1024, requestTimeout: 120000, trustProxy: false,
});
const store = new Store(config.dataDir);
const siteAccess = new SiteAccess(store, config);
let onSlotActivity: (slotId: string) => void = () => undefined;
const localExecution = new ProcessExecutionHost(config);
const machines = new MachinePlan(store, config.vmAddresses);
// Until an administrator saves them in the panel; the workspace memory variable predates the panel.
const machineResourceSettings = new MachineResourceSettingsStore(store, {
  slot: { cpu: 1, memoryMiB: 1536, diskGiB: 8 },
  workspace: { cpu: 1, memoryMiB: parseSize(config.workspaceMemory)! / 2 ** 20, diskGiB: 4 },
});
// Assigned once the SSH manager exists; the VM host only calls it when serving a sync barrier.
let mutagenEnvironment: (userId: string) => Promise<NodeJS.ProcessEnv> = async () => { throw new Error('同步服务尚未就绪'); };
let clientExecHandler: (userId: string, request: ClientExecBarrierRequest) => Promise<ClientExecBarrierReply> = async () => ({ ok: false, error: '客户端命令执行屏障尚未就绪' });
const execution = config.executionHost === 'lxd' ? new LxdExecutionHost(config, localExecution, {
  plan: machines,
  syncProject: (userId, syncName) => store.get<{ local_path: string }>(
    "SELECT local_path FROM projects WHERE user_id=? AND sync_name=? AND execution_mode IS NOT 'local'", userId, syncName)?.local_path,
  mutagenEnvironment: userId => mutagenEnvironment(userId),
  reportSkippedLinks: (userId, syncName, skipped) => describeSkippedLinks(recordSkippedLinks(store, events, userId, syncName, skipped)),
  clientExec: (userId, request) => clientExecHandler(userId, request),
  resources: kind => machineResourceSettings.view()[kind],
}) : localExecution;
for (const slot of store.all<{ id: string; home_dir: string; engine: string }>('SELECT id,home_dir,engine FROM account_slots')) {
  await execution.assertReleased(slot.home_dir);
  if (slot.engine === 'claude') await ensureClaudeSlotIdentity(config.dataDir, slot.id, slot.home_dir);
}
const targetPolicy = new SshTargetPolicy({
  vmBridge: config.vmBridge,
  gatewayHost: config.gateway?.host,
  extraDeny: config.sshRelayDeny,
});
const devHostApprovals = new DevHostApprovalStore(store);
const ssh = new SshManager(config, {
  execution,
  policy: targetPolicy,
  approvals: devHostApprovals,
  vmBridge: config.vmBridge,
  sshRelayPort: config.sshRelayPort,
});
const credentials = new AccountCredentials(config.dataDir, store, execution, new SlotTokens(config.dataDir, ssh.keys),
  slotId => onSlotActivity(slotId));
const sshRelay = new SshRelayServer({
  vmBridge: config.vmBridge,
  port: config.sshRelayPort,
  store,
  machines,
  credentials,
  approvals: devHostApprovals,
  policy: targetPolicy,
  logger: app.log,
});
ssh.setRelay(sshRelay);
credentials.onBeforeSlotRevoke((slotId, reason) => sshRelay.revoke({ slotId }, reason).then(() => undefined));
if (execution instanceof LxdExecutionHost) {
  execution.onBeforeMachineRevoke = async (address, reason) => {
    await sshRelay.revoke({ srcIp: address }, reason);
  };
}
await credentials.recover();
const connections = new ConnectionRegistry(store);
const events = new EventBus(store, config.approvalTimeoutMs);
const clientHostRegistry = new ClientHostRegistry(store, events);
const clientWorkspaceAdapter = new ClientWorkspaceAdapter(clientHostRegistry);
const clientMirrorSync = new ClientMirrorSync(config, store, clientHostRegistry, execution);
const clientExecBarrier = new ClientExecBarrier(config, store, clientMirrorSync, clientWorkspaceAdapter,
  (userId, syncName, skipped) => describeSkippedLinks(recordSkippedLinks(store, events, userId, syncName, skipped)));
clientExecHandler = (userId, request) => clientExecBarrier.execute(userId, request);
const clientSsh = new ClientSshServer({
  dataDir: config.dataDir, host: config.clientSshBind, port: config.clientSshPort, store, keyStore: ssh.keys, registry: clientHostRegistry, logger: app.log,
});
const slotRecipients = (slotId: string) => store.all<{ user_id: string }>(`SELECT user_id FROM slot_user_access WHERE slot_id=?
    UNION SELECT id AS user_id FROM users WHERE role='admin'`, slotId).map(row => row.user_id);
const usageSettings = new UsageSettingsStore(store);
const usage = new SlotUsage({ dataDir: config.dataDir, execution, settings: () => usageSettings.view() }, credentials, slotId => {
  const payload = { slotId, usage: usage.view(slotId) };
  for (const userId of slotRecipients(slotId)) events.broadcast(userId, { type: 'slot-usage', payload });
});
await usage.init();
// Slot machines exist only with the VM host, and only then does a slot need a gateway binding.
const slotMachines = config.executionHost === 'lxd' ? machines : undefined;
let gateway: GatewayService | undefined;
const hostCommands = execution.kind === 'vm' ? new HostCommands(config, ssh.keys) : undefined;
const agentConfig = { ...config, credentials, usage, execution, catalogs: new SlotModelCatalogs(store),
  orchestration: undefined as OrchestrationHost | undefined,
  workspaces: undefined as AgentWorkspaceBridge | undefined,
  egress: { assertBound: async (slotId: string) => { await gateway?.assertBound(slotId); } },
  hostShell: async (context: AgentContext) => context.project.execution_mode === 'local' && hostCommands
    ? hostCommands.ensureReady() : null };
const questionDefaults = new QuestionDefaults(store, config.approvalTimeoutMs);
const agentDefaults = new AgentDefaults(store);
const prices = new PriceBook(store);
const tokenUsage = new TokenUsageLedger(store, prices);
const slots = new SlotSelector(store, agentConfig);
onSlotActivity = slotId => {
  for (const userId of slotRecipients(slotId)) events.broadcast(userId, { type: 'slot', payload: { id: slotId } });
};
const turns = new ConversationStore(store, turn => {
  const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', turn.session_id);
  if (session) events.broadcast(session.user_id, { type: 'turn', sessionId: turn.session_id, payload: turn });
});
mutagenEnvironment = userId => ssh.mutagenEnvironment(userId);
const workspaces = new WorkspaceManager(config, ssh, execution, {
  store, registry: clientHostRegistry, adapter: clientWorkspaceAdapter, mirror: clientMirrorSync,
  clientExecSocketPath: execution.kind === 'vm' ? '/run/clinavat-relay/barrier.sock' : clientExecBarrier.socketPath,
  clientExecTokenFor: execution.kind === 'vm' ? undefined : projectId => clientExecBarrier.tokenForProject(projectId),
});
agentConfig.workspaces = workspaces.agentBridge();
workspaces.onSkippedLinks = (project, skipped) => { recordSkippedLinks(store, events, project.user_id, project.sync_name, skipped); };
for (const host of store.all<Host>('SELECT * FROM dev_hosts')) {
  if (host.kind !== 'ssh') continue;
  try { await ssh.addHost(host.user_id, host); }
  catch (error) { app.log.error({ err: error, hostId: host.id }, '无法恢复开发机运行时密钥'); }
}
// A first sync runs after its request returns, so a restart can interrupt it; the user retries it from the workspace.
store.run("UPDATE projects SET sync_status='ERROR' WHERE sync_status='CREATING'");
for (const project of store.all<Project>("SELECT * FROM projects WHERE sync_status='WATCHING'")) {
  const host = store.get<Host>('SELECT * FROM dev_hosts WHERE id=?', project.dev_host_id);
  if (!host || (host.kind === 'client' ? project.client_mode !== 'mirrored' : project.execution_mode === null)) continue;
  try { await workspaces.refreshExecutor(project, host); }
  catch (error) {
    store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
    app.log.error({ err: error, projectId: project.id }, '无法刷新项目远程执行器');
  }
}
// Assigned once the context exists; it sees every agent event, and turn ends drive child reports.
let observeAgentEvent: (event: AgentEvent) => void = () => undefined;
let maintenance: MaintenanceService | undefined;
const agents: AgentManager = new AgentManager(agentConfig, {
  isMaintenanceMode: () => maintenance?.isEnabled() ?? false,
  verifyAutomaticSlot: previous => slots.ensureEligible(
    slotForUser(store, previous.slot.id, previous.user.id, previous.session.engine), previous.user.id, previous.session.model),
  assertAutomaticSlot(previous) {
    if (!slots.eligible(previous.slot, previous.user.id, previous.session.model)) {
      throw new HttpError(409, '账号额度或身份已变化，请重新选择可用账号');
    }
  },
  loadQueuedInputs(sessionId) {
    const queue = store.get<{ inputs: string }>('SELECT inputs FROM session_input_queue WHERE session_id=?', sessionId);
    return queue ? JSON.parse(queue.inputs) : [];
  },
  questionPolicy: sessionId => questionDefaults.forSession(sessionId),
  recordTokenUsage(owner, update) {
    try { tokenUsage.apply(owner, update); }
    catch (error) { app.log.error({ err: error, sessionId: owner.sessionId }, '无法记录 Token 用量'); }
  },
  deferQuestion(question) {
    store.run('INSERT INTO deferred_questions(id,session_id,questions,created_at) VALUES(?,?,?,?)',
      question.id, question.session_id, JSON.stringify(question.questions), question.created_at);
  },
  saveQueuedInputs(sessionId, inputs) {
    if (!inputs.length) { store.run('DELETE FROM session_input_queue WHERE session_id=?', sessionId); return; }
    store.run(`INSERT INTO session_input_queue(session_id,inputs) VALUES(?,?)
      ON CONFLICT(session_id) DO UPDATE SET inputs=excluded.inputs,updated_at=datetime('now')`, sessionId, JSON.stringify(inputs));
  },
  quotaReached(previous, quota) {
    slots.recordLimit(previous.slot, quota, previous.account_identity ?? null);
    usage.observe(previous.slot, 'claude-event', { status: 'rejected', rateLimitType: quota.window,
      ...(quota.resetsAt ? { resetsAt: Date.parse(quota.resetsAt) / 1000 } : {}) }, previous.account_identity ?? null);
  },
  prepareFailover: (previous, quota, excludedSlotIds, signal) => prepareSlotFailover(context, previous, quota, excludedSlotIds, signal),
  event(event) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', event.sessionId);
    if (session) {
      if (event.type === 'turn-state') {
        const payload = event.payload as { status: 'running' | 'pausing' | 'paused' | 'completed' | 'interrupted' | 'error'; turnId?: string };
        if (payload.status === 'running' || payload.status === 'pausing' || payload.status === 'paused') {
          turns.setState(event.sessionId, payload.status, payload.turnId);
        } else turns.finish(event.sessionId, payload.status, payload.turnId);
        observeAgentEvent(event);
        return;
      }
      if (event.type === 'error') observeAgentEvent(event);
      if (event.type === 'runtime') {
        events.broadcast(session.user_id, event);
        observeAgentEvent(event);
        return;
      }
      if (event.type === 'turn-anchor') {
        const anchor = event.payload as { turnId?: string; ref: string; nativeSessionId: string };
        if (anchor.turnId) turns.anchor(event.sessionId, anchor.turnId, anchor.ref, anchor.nativeSessionId, session.native_inspect_tools ?? 0);
        return;
      }
      if (event.type === 'tool' || event.type === 'activity') {
        if (!turns.record(event.sessionId, event.type, event.payload)) events.broadcast(session.user_id, event);
        return;
      }
      if (event.type === 'done') events.cancelSession(session.user_id, event.sessionId);
      events.emit(session.user_id, event);
    }
  },
  saveMessage(sessionId, role, content) {
    if (!content.trim()) return;
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) return;
    const id = randomUUID();
    store.run('INSERT INTO messages(id,session_id,role,content) VALUES(?,?,?,?)', id, sessionId, role, content);
    if (role === 'assistant') turns.attachAnswer(sessionId, id);
    events.emit(session.user_id, { type: 'message', sessionId, payload: store.get('SELECT * FROM messages WHERE id=?', id) });
  },
  async updateSession(sessionId, fields) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) return;
    if (fields.jsonl_file_path) {
      // Codex may return its rollout path before asynchronous persistence creates this optional metadata file.
      const transcript = await realpath(fields.jsonl_file_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      fields = { ...fields, jsonl_file_path: transcript };
    }
    for (const key of ['native_session_id', 'native_inspect_tools', 'status', 'jsonl_file_path'] as const) {
      if (fields[key] !== undefined) store.run(`UPDATE sessions SET ${key}=?,updated_at=datetime('now') WHERE id=?`, fields[key]!, sessionId);
    }
    events.emit(session.user_id, { type: 'session', sessionId, payload: store.get('SELECT * FROM sessions WHERE id=?', sessionId) });
  },
  saveUserMessage(sessionId, content, images, source, id = randomUUID()) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) throw new Error('会话不存在');
    store.run("INSERT INTO messages(id,session_id,role,content,images,source) VALUES(?,?,'user',?,?,?)", id, sessionId, content,
      storedImages(images), source ?? null);
    if (!source) resetReviewsForUserMessage(context, session);
    events.emit(session.user_id, { type: 'message', sessionId, payload: store.get('SELECT * FROM messages WHERE id=?', id) });
    return id;
  },
  loadImages: (sessionId, ids) => loadImages(store, sessionId, ids),
  beginTurn(sessionId, origin, authorization) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    if (!session) throw new Error('会话不存在');
    let messageId: string;
    if ('messageId' in origin) messageId = origin.messageId;
    else {
      // A turn the CLI began after a background task has no user message; a system note anchors it.
      messageId = randomUUID();
      store.run("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'system',?)", messageId, sessionId,
        origin.summary ? `后台任务结束：${origin.summary.slice(0, 2000)}` : '后台任务结束，智能体继续处理');
      events.emit(session.user_id, { type: 'message', sessionId, payload: store.get('SELECT * FROM messages WHERE id=?', messageId) });
    }
    return turns.start(sessionId, messageId, authorization, randomUUID()).id;
  },
  steered(sessionId, messageId, turnId) {
    turns.steer(sessionId, messageId, turnId);
  },
  approval(request) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', request.sessionId);
    if (!session) return Promise.resolve({ decision: 'deny', reason: '会话不存在' });
    return events.requestApproval(session.user_id, request);
  },
  async flushWorkspace(sessionId) {
    const session = store.get<Session>('SELECT * FROM sessions WHERE id=?', sessionId);
    const project = session && store.get<Project>('SELECT * FROM projects WHERE id=?', session.project_id);
    if (!project) throw new Error('项目不存在，无法同步智能体修改');
    try { await workspaces.flush(project); }
    catch (error) {
      store.run("UPDATE projects SET sync_status='ERROR' WHERE id=?", project.id);
      events.emit(session.user_id, { type: 'project', payload: { id: project.id, sync_status: 'ERROR' } });
      throw error;
    }
  },
});
credentials.reclaimIdle = slotId => agents.reclaimWhere({ slotId });
usage.readResident = slot => agents.readUsage(slot);
handleIdleReclaimSignal = () => {
  const reclaimed = agents.reclaimIdle();
  app.log.info({ reclaimed }, 'SIGUSR2 触发空闲常驻 CLI 回收');
};
const maintenanceService = new MaintenanceService(store, agents, credentials, events);
maintenance = maintenanceService;

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 65536 } });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') });
  const problem = error as Error & { statusCode?: number; code?: string };
  if (problem.message.includes('CLINAVAT_RELEASE_IN_PROGRESS')) {
    return reply.code(503).send({ error: '系统正在更新，请稍后重试。' });
  }
  if (problem.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: '资源已存在或已绑定' });
  const statusCode = problem.statusCode && problem.statusCode >= 400 ? problem.statusCode : 500;
  if (statusCode >= 500) app.log.error(problem);
  return reply.code(statusCode).send({ error: statusCode === 500 ? '操作失败，请查看服务日志' : problem.message });
});
app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cache-Control', 'no-store');
});
registerAuth(app, store, config, ssh, connections, siteAccess);
registerMaintenanceGuard(app, maintenanceService);
events.register(app, connections);
const context = { config: agentConfig, store, events, ssh, targetPolicy, devHostApprovals, sshRelay, clientHostRegistry, clientSsh, clientWorkspaceAdapter, clientMirrorSync, workspaces, agents, connections, turns, slots, questionDefaults, agentDefaults, tokenUsage, prices, hostCommands,
  usageSettings, orchestrationSettings: new OrchestrationSettingsStore(store), machineResourceSettings, machineResources: execution instanceof LxdExecutionHost ? execution : undefined, maintenance: maintenanceService, btw: undefined as unknown as BtwService };
const btw = new BtwService(context);
const worktrees = new WorktreeManager(context);
Object.assign(context, { worktrees, btw });
const orchestrator = new Orchestrator(context);
agentConfig.orchestration = orchestrator;
observeAgentEvent = event => orchestrator.observe(event);
resourceRoutes(app, context);
clientDeviceRoutes(app, context);
sessionRoutes(app, context);
sessionAgentRoutes(app, context, orchestrator);
agentModelRoutes(app, context);
completionRoutes(app, context);
adminRoutes(app, context);
siteAccessRoutes(app, siteAccess);
siteSettingsRoutes(app, new SiteSettingsService(store), store, events);
questionDefaultsRoutes(app, context);
tokenUsageRoutes(app, context);
gateway = new GatewayService(new GatewayClient(config, ssh.keys), store, slotMachines, config.imageBuilderAddress,
  execution instanceof LxdExecutionHost ? execution : undefined);
gatewayRoutes(app, gateway, context);
app.get('/api/health', async () => {
  const { kind, ...runtime } = await execution.health();
  const { enabled, message } = maintenanceService.getState();
  return {
    status: 'ok',
    version: '0.1.0',
    execution: kind,
    runtime,
    maintenance: { enabled, message },
    reclaimIdleSignal: 'SIGUSR2',
  };
});
app.addHook('preClose', async () => {
  connections.close();
  events.close();
  revokeTerminalSockets({}, '服务正在关闭');
  await btw.close();
  await agents.close();
  await credentials.close();
  clientHostRegistry.closeAll('服务正在关闭');
  await clientExecBarrier.stop();
  await clientSsh.stop();
  await sshRelay.stop();
});
app.addHook('onClose', async () => { await ssh.close(); store.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
});
try {
  if (config.executionHost === 'lxd') await sshRelay.start();
  else await clientExecBarrier.start();
  await clientSsh.start();
  await app.listen({ host: config.host, port: config.port });
  // Prepares the key and logs in once, so a broken path shows in the admin panel before anyone needs it.
  void hostCommands?.check().then(status => {
    if (!status.ready) app.log.error({ error: status.error }, '宿主机命令入口不可用');
  });
  // Guests run their own Mutagen daemons; asking for status boots the VM and restarts the daemon. Not awaited,
  // because a cold boot takes about a minute per user and the site must stay available meanwhile.
  if (execution.kind === 'vm') {
    void Promise.allSettled(store.all<Project>(
      `SELECT p.* FROM projects p JOIN dev_hosts h ON h.id=p.dev_host_id
       WHERE p.sync_status='WATCHING' AND p.execution_mode<>'local' AND h.kind='ssh'`,
    ).map(project => workspaces.status(project).catch(error => app.log.error({ err: error, projectId: project.id }, '无法恢复虚拟机内的项目同步'))));
  }
}
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
