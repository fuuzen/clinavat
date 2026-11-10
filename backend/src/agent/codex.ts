import { agentEnvironment, agentScope, observeProcessClose, terminateProcess } from './environment.js';
import { RpcClient, type RpcMessage } from './rpc.js';
import { loadAgentModels } from './model-catalog.js';
import { codexPermissions, createCodexRequests } from './codex-requests.js';
import { projectInstructions } from './project-instructions.js';
import { roleInstructions } from './session-settings.js';
import { codexServerArguments, createCodexGoalController, initializeCodexServer, type CodexGoalChange } from './codex-goal.js';
import type { AgentRun, RunServices } from './types.js';
import { parseCodexRead } from '../accounts/usage-parsers.js';

export async function startCodex(services: RunServices, prompt: string, signal: AbortSignal): Promise<AgentRun> {
  if (services.context.session.goal && services.context.session.agent_mode === 'plan') {
    throw new Error('Goal 自动执行需要普通模式，请切换模式后重试');
  }
  const { execution } = services.config;
  const binary = await execution.binary(agentScope(services.context), 'codex');
  const root = services.context.project.local_path;
  const permissions = codexPermissions(services);
  const arguments_ = codexServerArguments(services.context);
  if (signal.aborted) throw new Error('会话已停止');
  const child = await execution.spawn(binary, arguments_, {
    scope: agentScope(services.context), cwd: root, env: agentEnvironment(execution, services.context),
  });
  services.control.track(child);
  const closed = observeProcessClose(child);
  let threadId = '';
  let turnId = '';
  let activeTurnId = '';
  let diagnostics = '';
  let finished = false;
  let stopped = false;
  let turnActive = true;
  let interruptRequested = false;
  // Commands may outlive the turn that started them; the process must stay until they end.
  const runningCommands = new Set<string>();
  let nativePaused = false;
  let resumeGoal = false;
  let turnAbort = new AbortController();
  let pauseWaiter: { turnId: string; resolve(): void; reject(error: Error): void } | undefined;
  let textSize = 0;
  let mutations: Promise<unknown> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutations.then(operation, operation);
    mutations = result.catch(() => undefined);
    return result;
  };
  const messages = new Map<string, string>();
  const phases = new Map<string, string>();
  const currentAnswerIds = new Set<string>();
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; })
    .finally(() => closed);
  void completion.catch(() => undefined);
  const finalAnswer = (failed: boolean) => {
    const explicitFinal = [...currentAnswerIds].filter(id => phases.get(id) === 'final_answer');
    const unclassified = [...currentAnswerIds].filter(id => !phases.has(id));
    const finalIds = explicitFinal.length ? explicitFinal : !failed && !stopped ? unclassified.slice(-1) : [];
    for (const id of finalIds) services.event('activity', { id, kind: 'text', text: messages.get(id) || '', final: true });
    const text = finalIds.map(id => messages.get(id)).join('\n\n').trim();
    return text || (services.context.session.command === 'compact' && !failed && !stopped ? '原生上下文已压缩。网页中的历史消息仍会保留。' : '');
  };
  const endTurn = (error?: Error) => {
    if (!turnActive || finished) return;
    turnActive = false;
    const wasInterrupted = interruptRequested;
    interruptRequested = false;
    turnAbort.abort();
    requests.close();
    const output = finalAnswer(!!error);
    messages.clear();
    phases.clear();
    currentAnswerIds.clear();
    textSize = 0;
    services.turnEnded(wasInterrupted ? { status: 'interrupted', output } : error ? { status: 'error', error: error.message, output } : { status: 'completed', output });
  };
  // Ends the process. A turn still running is left for the manager to record from the rejection.
  const finish = async (error?: Error) => {
    if (finished) return;
    const unfinishedTurn = turnActive;
    if (turnActive && !error && !stopped) endTurn();
    finished = true;
    pauseWaiter?.reject(error ?? new Error('当前执行已结束'));
    pauseWaiter = undefined;
    turnAbort.abort();
    requests.close();
    signal.removeEventListener('abort', abort);
    if (unfinishedTurn && turnActive) {
      const output = finalAnswer(true);
      if (output) services.event('activity', { id: 'codex-partial-answer', kind: 'text', text: output, final: true });
    }
    rpc.close();
    child.stdin.end();
    terminateProcess(child);
    if (error && !stopped && turnActive) rejectCompletion(error);
    else resolveCompletion();
  };
  const onMessage = async (message: RpcMessage) => {
    const params = message.params ?? {};
    if (goals.observe(message)) return;
    if (message.method === 'item/started' && params.item?.type === 'commandExecution') runningCommands.add(String(params.item.id));
    if (message.method === 'item/completed' && params.item?.type === 'commandExecution' && runningCommands.delete(String(params.item.id))) {
      services.activityChanged();
    }
    if (params.turnId && turnId && params.turnId !== turnId && message.method !== 'turn/started') return;
    if (message.id !== undefined && message.method) {
      if (await requests.handle(message)) return;
      rpc.send({ id: message.id, error: { code: -32601, message: '当前工作台不支持此交互请求，请通过对话向用户说明。' } });
      return;
    }
    if (message.method === 'serverRequest/resolved') requests.resolved(params.requestId);
    if (message.method === 'account/rateLimits/updated') services.config.usage?.observe(services.context.slot, 'codex-event',
      params, services.context.account_identity);
    if (message.method === 'item/commandExecution/outputDelta') {
      services.event('tool', { id: params.itemId, tool: 'commandExecution', output: String(params.delta ?? '').slice(0, 128 * 1024), status: 'running', append: true });
    }
    if (message.method === 'item/agentMessage/delta') {
      const text = String(params.delta ?? '');
      if (textSize + text.length > 8 * 1024 * 1024) {
        await finish(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
      }
      const id = String(params.itemId ?? 'partial');
      currentAnswerIds.add(id);
      messages.set(id, (messages.get(id) ?? '') + text);
      textSize += text.length;
      services.event('activity', { id, kind: 'text', text, append: true });
    }
    if (message.method === 'item/reasoning/summaryTextDelta') {
      services.event('activity', {
        id: `${params.itemId}:summary:${params.summaryIndex ?? 0}`, kind: 'reasoning',
        text: String(params.delta ?? ''), append: true,
      });
    }
    if (message.method === 'item/started') {
      const item = params.item;
      if (item && typeof item === 'object') requests.record(item);
      if (item?.type === 'agentMessage' && typeof item.phase === 'string') phases.set(String(item.id), item.phase);
      if (item && ['webSearch', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
        services.event('tool', { id: item.id, tool: item.type === 'fileChange' ? 'apply_patch' : item.type, input: item.command ?? item.action ?? item.arguments ?? item.changes, status: 'running' });
      }
    }
    if (message.method === 'item/completed') {
      const item = params.item;
      if (item?.id) requests.forget(String(item.id));
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        const id = String(item.id);
        currentAnswerIds.add(id);
        textSize += item.text.length - (messages.get(id)?.length ?? 0);
        if (textSize > 8 * 1024 * 1024) {
          await finish(new Error('CLI 文本输出超过 8 MiB，已停止会话')); return;
        }
        messages.set(id, item.text);
        if (typeof item.phase === 'string') phases.set(id, item.phase);
        services.event('activity', { id, kind: 'text', text: item.text });
      }
      if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
        item.summary.forEach((text: unknown, index: number) => {
          if (typeof text === 'string') services.event('activity', { id: `${item.id}:summary:${index}`, kind: 'reasoning', text });
        });
      }
      if (item && ['webSearch', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
        services.event('tool', { id: item.id, tool: item.type === 'fileChange' ? 'apply_patch' : item.type, input: item.command ?? item.action ?? item.arguments ?? item.changes,
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 128 * 1024) : undefined,
          status: item.status === 'declined' ? 'declined'
            : ['cancelled', 'canceled', 'interrupted'].includes(item.status) ? 'interrupted'
            : item.status === 'failed' || item.exitCode > 0 ? 'failed' : 'completed' });
      }
    }
    if (message.method === 'turn/diff/updated') services.event('tool', { id: 'turn-diff', tool: 'diff', output: params.diff, status: 'completed' });
    if (message.method === 'turn/plan/updated') {
      const plan = Array.isArray(params.plan) ? params.plan.map((step: { step?: string; status?: string }) =>
        `${step.status === 'completed' ? '☑' : step.status === 'inProgress' ? '◉' : '○'} ${step.step || ''}`).join('\n') : '';
      services.event('activity', { id: 'native-plan', kind: 'text', text: [params.explanation, plan].filter(Boolean).join('\n\n') });
    }
    if (message.method === 'turn/started') {
      turnId = String(params.turn?.id ?? turnId);
      activeTurnId = turnId;
    }
    if (message.method === 'error') {
      services.event('error', { message: String(params.error?.message ?? 'Codex 运行错误') });
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn ?? {};
      if (turn.id && turnId && turn.id !== turnId) return;
      activeTurnId = '';
      const waiting = pauseWaiter;
      if (waiting && waiting.turnId === turn.id && turn.status === 'interrupted') {
        nativePaused = true;
        turnAbort.abort();
        requests.close();
        waiting.resolve();
        return;
      }
      if (turn.status === 'completed' && services.control.state === 'pausing' && !services.context.session.command) {
        if (waiting) {
          nativePaused = true;
          turnAbort.abort();
          requests.close();
          waiting.resolve();
        }
        return;
      }
      if (turn.status === 'completed' && !stopped) {
        try {
          const goal = await goals.get();
          // An active goal continues in a new native turn; the Hub keeps it as one turn.
          if (finished || activeTurnId || goal?.status === 'active'
            && services.context.session.agent_mode !== 'plan' && !services.context.session.command) return;
        } catch (error) {
          await finish(error instanceof Error ? error : new Error('无法读取目标状态'));
          return;
        }
      }
      if (stopped) return;
      endTurn(turn.status === 'failed' ? new Error(String(turn.error?.message ?? 'Codex 会话失败'))
        : turn.status === 'interrupted' && !interruptRequested ? new Error('Codex 执行已中断') : undefined);
    }
  };
  const rpc = new RpcClient(child, onMessage, (error) => { void finish(error); }, services.control);
  const goals = createCodexGoalController(rpc, () => threadId, goal => services.event('goal', { goal }));
  const makeRequests = () => createCodexRequests(services, AbortSignal.any([signal, turnAbort.signal]),
    message => rpc.send(message), () => !finished && !stopped);
  let requests = makeRequests();
  let requestTurn: (input: { type: 'text'; text: string }[]) => Promise<any> = async () => { throw new Error('Codex 尚未就绪'); };
  const abort = () => {
    stopped = true;
    turnAbort.abort();
    pauseWaiter?.reject(new Error('会话已停止'));
    requests.close();
    if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => undefined);
    terminateProcess(child);
  };
  signal.addEventListener('abort', abort, { once: true });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-16 * 1024); });
  child.once('error', (error) => { void finish(error); });
  child.once('close', (code, exitSignal) => {
    if (!finished) void finish(stopped || !turnActive ? undefined : new Error(diagnostics.trim() || `Codex app-server 已退出（${code ?? exitSignal}）`));
  });
  try {
    if (signal.aborted) { abort(); throw new Error('会话已停止'); }
    await initializeCodexServer(rpc);
    // A full snapshot at run start; later notifications only carry changed values.
    if (services.config.usage) void rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000)
      .then(result => services.config.usage?.observe(services.context.slot, 'codex-read', result,
        services.context.account_identity)).catch(() => undefined);
    const selection = services.context.session;
    const models = await loadAgentModels(services.config, services.context);
    const model = selection.model || models.find(item => item.isDefault)?.id;
    const effort = selection.reasoning_effort || models.find(item => item.id === model)?.defaultReasoningEffort;
    await services.verifyShell();
    const shared = { cwd: root, sandbox: permissions.sandbox, approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer, developerInstructions: projectInstructions(services.context.project, 'codex') + roleInstructions(selection.role_preset),
      ...(model ? { model } : {}),
      config: { 'features.shell_tool': true, 'features.unified_exec': true, 'features.multi_agent': false, 'features.goals': true,
        ...(effort ? { model_reasoning_effort: effort } : {}) } };
    const nativeId = services.context.session.native_session_id;
    // Each slot indexes the shared history through its own path; native resume resolves that path by ID.
    const result = nativeId
      ? await rpc.request('thread/resume', { ...shared, threadId: nativeId, excludeTurns: true })
      : await rpc.request('thread/start', shared);
    if (!result?.thread?.id) throw new Error('Codex 未返回线程 ID，请确认固定版本的 app-server 协议');
    if (nativeId && result.thread.id !== nativeId) throw new Error('Codex 恢复的会话与当前对话不一致');
    threadId = String(result.thread.id);
    if (signal.aborted) throw new Error('会话已停止');
    await services.update({ native_session_id: threadId });
    await goals.get();
    const turnSettings = {
      threadId, cwd: root,
      approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(model ? { collaborationMode: {
        mode: selection.agent_mode === 'plan' ? 'plan' : 'default',
        settings: { model, reasoning_effort: effort ?? null, developer_instructions: null },
      } } : {}),
    };
    requestTurn = (input: { type: 'text'; text: string }[]) => rpc.request('turn/start', {
      ...turnSettings, input,
    }, 120000, false);
    if (!finished && services.context.session.command !== 'compact') services.control.setNative({
      pause: () => mutate(async () => {
        if (finished || stopped) throw new Error('当前执行已结束');
        if (nativePaused) return;
        resumeGoal = (await goals.get())?.status === 'active' && selection.agent_mode !== 'plan';
        if (resumeGoal) await goals.set({ action: 'pause' });
        if (!activeTurnId) {
          nativePaused = true;
          turnAbort.abort();
          requests.close();
          return;
        }
        const waitingTurnId = turnId;
        const confirmation = new Promise<void>((resolve, reject) => { pauseWaiter = { turnId: waitingTurnId, resolve, reject }; });
        void confirmation.catch(() => undefined);
        const cancelTimeout = services.control.timer(() => pauseWaiter?.reject(new Error('Codex 未确认暂停，请停止后重试')), 15000);
        try {
          await rpc.request('turn/interrupt', { threadId, turnId: waitingTurnId }, 10000);
          await confirmation;
        } catch (error) {
          if (nativePaused && !finished && !stopped) return;
          const failure = error instanceof Error ? error : new Error('Codex 暂停失败');
          await finish(failure);
          throw failure;
        } finally { cancelTimeout(); pauseWaiter = undefined; }
      }),
      resume: () => mutate(async () => {
        if (finished || stopped) throw new Error('当前执行已结束');
        if (!nativePaused) return;
        turnAbort = new AbortController();
        requests = makeRequests();
        currentAnswerIds.clear();
        try {
          // An empty input continues the native context without adding a user message or synthetic prompt.
          if (resumeGoal) await goals.set({ action: 'resume' });
          else {
            const next = await requestTurn([]);
            turnId = String(next?.turn?.id ?? turnId);
          }
          nativePaused = false;
        } catch (error) {
          turnAbort.abort();
          requests.close();
          const failure = error instanceof Error ? error : new Error('Codex 继续失败');
          await finish(failure);
          throw failure;
        }
      }),
      close() { pauseWaiter?.reject(new Error('会话已停止')); },
    });
    const goalRequest = selection.goal;
    if (goalRequest) {
      await rpc.request('thread/settings/update', turnSettings, 30000, false);
      if (goalRequest.action === 'create') await goals.create(goalRequest.objective ?? '');
      else await goals.set({ action: 'resume' });
    } else {
      const turn = selection.command === 'compact'
        ? await rpc.request('thread/compact/start', { threadId })
        : await requestTurn([{ type: 'text', text: prompt }]);
      turnId = String(turn?.turn?.id ?? turnId);
    }
    if (typeof result.thread.path === 'string') await services.update({ jsonl_file_path: result.thread.path });
  } catch (error) {
    requests.close();
    terminateProcess(child);
    rpc.close();
    signal.removeEventListener('abort', abort);
    await closed;
    await completion.catch(() => undefined);
    throw new Error(`Codex 启动失败：${error instanceof Error ? error.message : '协议不兼容'}`);
  }
  return {
    process: child, completion, stop: abort,
    readUsage: async () => parseCodexRead(await rpc.request('account/rateLimits/read',
      { excludeResetCreditDetails: true }, 30000, false)),
    startTurn: (text) => mutate(async () => {
      if (finished || stopped) throw new Error('当前执行已结束');
      turnActive = true;
      interruptRequested = false;
      turnAbort = new AbortController();
      requests = makeRequests();
      try {
        await services.verifyShell();
        const turn = await requestTurn([{ type: 'text', text }]);
        turnId = String(turn?.turn?.id ?? turnId);
      } catch (error) {
        endTurn(error instanceof Error ? error : new Error('Codex 无法开始新一轮'));
      }
    }),
    steer: async (text) => {
      const expectedTurnId = activeTurnId;
      if (!turnActive || !expectedTurnId || nativePaused || finished) return false;
      try {
        await rpc.request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text }] }, 30000, false);
        return true;
      } catch (error) {
        // The turn ended between the check and the request; the caller starts a new turn instead.
        if (activeTurnId !== expectedTurnId) return false;
        throw error;
      }
    },
    interruptTurn: () => mutate(async () => {
      if (!turnActive || finished) return;
      interruptRequested = true;
      if ((await goals.get())?.status === 'active') await goals.set({ action: 'pause' });
      if (activeTurnId) await rpc.request('turn/interrupt', { threadId, turnId: activeTurnId }, 10000);
      else endTurn();
    }),
    isIdle: () => !turnActive && !runningCommands.size,
    close: () => { void finish(); },
    tasks: () => [],
    stopTask: async () => { throw new Error('Codex 不提供后台任务控制'); },
    goal: {
    get: () => goals.get(),
    set: (input: CodexGoalChange) => mutate(async () => {
      if (finished || stopped) throw new Error('当前执行已结束');
      if (input.action === 'resume' && services.control.state !== 'running') throw new Error('请先继续当前任务，再恢复目标');
      if (input.action === 'resume' && services.context.session.agent_mode === 'plan') throw new Error('Goal 自动执行需要普通模式，请切换模式后重试');
      const goal = await goals.set(input);
      if (input.action === 'pause') resumeGoal = false;
      if (turnActive && !activeTurnId && !nativePaused && services.control.state === 'running' && goal?.status !== 'active') endTurn();
      return goal;
    }),
  } };
}
