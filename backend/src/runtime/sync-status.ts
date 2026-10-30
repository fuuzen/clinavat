interface SyncProblem { path?: string; error?: string }

interface SyncEndpoint {
  connected?: boolean;
  scanned?: boolean;
  directories?: number;
  files?: number;
  totalFileSize?: number;
  scanProblems?: SyncProblem[];
  excludedScanProblems?: number;
  transitionProblems?: SyncProblem[];
  excludedTransitionProblems?: number;
}

interface SyncSession {
  status: string;
  paused: boolean;
  lastError?: string;
  conflicts?: { root?: string }[];
  excludedConflicts?: number;
  alpha: SyncEndpoint;
  beta: SyncEndpoint;
}

const statusDescriptions: Record<string, string> = {
  disconnected: '连接已断开',
  'halted-on-root-emptied': '一端根目录被清空，同步已停止',
  'halted-on-root-deletion': '根目录被删除，同步已停止',
  'halted-on-root-type-change': '根目录类型改变，同步已停止',
  'connecting-alpha': '正在连接远端',
  'connecting-beta': '正在连接本地镜像',
  watching: '监视文件变更',
  scanning: '正在扫描文件',
  'waiting-for-rescan': '等待重新扫描',
  reconciling: '正在协调两端变更',
  'staging-alpha': '正在向远端传输文件',
  'staging-beta': '正在向镜像传输文件',
  transitioning: '正在应用文件变更',
  saving: '正在保存同步记录',
};

function readSession(stdout: string): SyncSession {
  let sessions: unknown;
  try { sessions = JSON.parse(stdout); }
  catch { throw new Error('无法解析 Mutagen 同步状态'); }
  if (!Array.isArray(sessions) || sessions.length !== 1) throw new Error('未找到唯一的项目同步会话');
  const session = sessions[0] as Partial<SyncSession> | null;
  if (!session || typeof session.status !== 'string' || typeof session.paused !== 'boolean'
    || !session.alpha || !session.beta) throw new Error('Mutagen 同步状态缺少必要字段');
  return session as SyncSession;
}

function compact(value: string, limit = 360): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; }
  return `${unit ? bytes.toFixed(2) : bytes} ${units[unit]}`;
}

function endpointDescription(label: string, endpoint: SyncEndpoint): string {
  const connection = endpoint.connected ? '已连接' : '未连接';
  if (!endpoint.connected) return `${label}：${connection}`;
  if (!endpoint.scanned) return `${label}：${connection}，尚未完成扫描`;
  return `${label}：${connection}，已扫描 ${endpoint.files ?? 0} 个文件、${endpoint.directories ?? 0} 个目录，${formatBytes(endpoint.totalFileSize ?? 0)}`;
}

function collectProblems(session: SyncSession): { lines: string[]; count: number } {
  const lines: string[] = [];
  let count = 0;
  const add = (line: string) => { count += 1; if (lines.length < 8) lines.push(line); };
  if (session.lastError) add(`同步错误：${compact(session.lastError)}`);
  for (const [label, endpoint] of [['远端（alpha）', session.alpha], ['镜像（beta）', session.beta]] as const) {
    for (const [stage, problems, excluded] of [
      ['扫描', endpoint.scanProblems, endpoint.excludedScanProblems],
      ['应用变更', endpoint.transitionProblems, endpoint.excludedTransitionProblems],
    ] as const) {
      for (const problem of problems ?? []) {
        add(`${label} ${stage} ${compact(problem.path || '.', 200)}：${compact(problem.error || '未知错误')}`);
      }
      count += excluded ?? 0;
    }
  }
  for (const conflict of session.conflicts ?? []) add(`两端文件冲突：${compact(conflict.root || '.', 200)}`);
  count += session.excludedConflicts ?? 0;
  return { lines, count };
}

export function parseSyncStatus(stdout: string): { status: 'WATCHING' | 'PAUSED' | 'ERROR' | 'SYNCING'; detail: string } {
  const session = readSession(stdout);
  const problems = collectProblems(session);
  const failed = problems.count > 0 || session.status === 'disconnected' || session.status.startsWith('halted-')
    || (session.status === 'watching' && (!session.alpha.connected || !session.beta.connected));
  const status = session.paused ? 'PAUSED' : failed ? 'ERROR' : session.status === 'watching' ? 'WATCHING' : 'SYNCING';
  const description = session.paused ? '已暂停' : statusDescriptions[session.status] ?? compact(session.status);
  const detail = [
    `同步状态：${description}`,
    endpointDescription('远端（alpha）', session.alpha),
    endpointDescription('镜像（beta）', session.beta),
    ...problems.lines,
    ...(problems.count > problems.lines.length ? [`另有 ${problems.count - problems.lines.length} 条问题未展示`] : []),
  ].join('\n');
  return { status, detail };
}

export function summarizeSyncFailure(stdout: string): string {
  return parseSyncStatus(stdout).detail;
}
