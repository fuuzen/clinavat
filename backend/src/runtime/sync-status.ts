interface SyncProblem { path?: string; error?: string }

interface StagingProgress {
  receivedFiles?: number;
  expectedFiles?: number;
  totalReceivedSize?: number;
}

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
  stagingProgress?: StagingProgress;
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

export interface SkippedLink { side: 'alpha' | 'beta'; path: string; reason: string }
export interface SkippedLinks { links: SkippedLink[]; more: number }

const LINK_PROBLEM = 'invalid symbolic link: ';

/**
 * Mutagen's portable mode refuses symbolic links with absolute, empty or malformed targets and links that leave
 * the project. It skips just those entries and keeps syncing the rest, so they are reported rather than failures.
 */
function splitScanProblems(endpoint: SyncEndpoint) {
  const listed = endpoint.scanProblems ?? [];
  const links = listed.filter(problem => problem.error?.startsWith(LINK_PROBLEM));
  const others = listed.filter(problem => !problem.error?.startsWith(LINK_PROBLEM));
  const excluded = endpoint.excludedScanProblems ?? 0;
  // Mutagen lists only the first problems; the unlisted ones count as links only when every listed one is.
  const linksOnly = listed.length > 0 && !others.length;
  return { links, others, moreLinks: linksOnly ? excluded : 0, moreOthers: linksOnly ? 0 : excluded };
}

function collectSkippedLinks(session: SyncSession): SkippedLinks {
  const result: SkippedLinks = { links: [], more: 0 };
  for (const side of ['alpha', 'beta'] as const) {
    const { links, moreLinks } = splitScanProblems(session[side]);
    result.links.push(...links.map(problem => ({
      side, path: problem.path || '.', reason: compact(problem.error!.slice(LINK_PROBLEM.length), 200),
    })));
    result.more += moreLinks;
  }
  return result;
}

export function parseSkippedLinks(stdout: string): SkippedLinks {
  return collectSkippedLinks(readSession(stdout));
}

function collectProblems(session: SyncSession): { lines: string[]; count: number } {
  const lines: string[] = [];
  let count = 0;
  const add = (line: string) => { count += 1; if (lines.length < 8) lines.push(line); };
  if (session.lastError) add(`同步错误：${compact(session.lastError)}`);
  for (const [label, endpoint] of [['远端（alpha）', session.alpha], ['镜像（beta）', session.beta]] as const) {
    const { others, moreOthers } = splitScanProblems(endpoint);
    for (const [stage, problems, excluded] of [
      ['扫描', others, moreOthers],
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

export function parseSyncStatus(stdout: string): {
  status: 'WATCHING' | 'PAUSED' | 'ERROR' | 'SYNCING'; detail: string; skipped: SkippedLinks;
} {
  const session = readSession(stdout);
  const problems = collectProblems(session);
  const skipped = collectSkippedLinks(session);
  const failed = problems.count > 0 || session.status === 'disconnected' || session.status.startsWith('halted-')
    || (session.status === 'watching' && (!session.alpha.connected || !session.beta.connected));
  const status = session.paused ? 'PAUSED' : failed ? 'ERROR' : session.status === 'watching' ? 'WATCHING' : 'SYNCING';
  const description = session.paused ? '已暂停' : statusDescriptions[session.status] ?? compact(session.status);
  const skippedCount = skipped.links.length + skipped.more;
  const detail = [
    `同步状态：${description}`,
    endpointDescription('远端（alpha）', session.alpha),
    endpointDescription('镜像（beta）', session.beta),
    ...problems.lines,
    ...(problems.count > problems.lines.length ? [`另有 ${problems.count - problems.lines.length} 条问题未展示`] : []),
    ...(skippedCount ? [`已跳过 ${skippedCount} 个无法同步的软链接（目标为绝对路径、指向项目外或格式无效）`] : []),
  ].join('\n');
  return { status, detail, skipped };
}

/**
 * Reasons the mirror may still differ from the remote. Scan problems on the remote and skipped symbolic links are
 * not among them: those entries never crossed over, and are often what a rule change is meant to exclude.
 */
export function syncBlockers(stdout: string): string[] {
  const session = readSession(stdout);
  const blockers: string[] = [];
  if (session.paused) blockers.push('同步已暂停');
  else if (session.status !== 'watching') blockers.push(`同步尚未完成：${statusDescriptions[session.status] ?? compact(session.status)}`);
  if (!session.alpha.connected || !session.beta.connected) blockers.push('同步两端未全部连接');
  if (session.lastError) blockers.push(`同步错误：${compact(session.lastError)}`);
  const conflicts = (session.conflicts?.length ?? 0) + (session.excludedConflicts ?? 0);
  if (conflicts) blockers.push(`两端有 ${conflicts} 处文件冲突`);
  const mirrorScan = splitScanProblems(session.beta);
  const problems = [
    ...mirrorScan.others.map(problem => ['镜像（beta） 扫描', problem] as const),
    ...(session.alpha.transitionProblems ?? []).map(problem => ['远端（alpha） 应用变更', problem] as const),
    ...(session.beta.transitionProblems ?? []).map(problem => ['镜像（beta） 应用变更', problem] as const),
  ];
  for (const [stage, problem] of problems.slice(0, 8)) {
    blockers.push(`${stage} ${compact(problem.path || '.', 200)}：${compact(problem.error || '未知错误')}`);
  }
  const hidden = problems.length - Math.min(problems.length, 8) + mirrorScan.moreOthers
    + (session.alpha.excludedTransitionProblems ?? 0) + (session.beta.excludedTransitionProblems ?? 0);
  if (hidden) blockers.push(`另有 ${hidden} 条问题未展示`);
  return blockers;
}

export function summarizeSyncFailure(stdout: string): string {
  return parseSyncStatus(stdout).detail;
}

export interface SyncProgress {
  description: string;
  /** Completed share between 0 and 1, or null while the amount of work is still unknown. */
  ratio: number | null;
  receivedFiles?: number;
  expectedFiles?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

// The mirror starts empty, so the first sync stages every remote file into it.
export function parseSyncProgress(stdout: string): SyncProgress {
  const session = readSession(stdout);
  const description = statusDescriptions[session.status] ?? compact(session.status);
  const totalBytes = session.alpha.scanned ? session.alpha.totalFileSize ?? 0 : undefined;
  if (session.status === 'staging-beta') {
    const staging = session.beta.stagingProgress ?? {};
    const receivedBytes = staging.totalReceivedSize ?? 0;
    const ratio = totalBytes ? receivedBytes / totalBytes
      : staging.expectedFiles ? (staging.receivedFiles ?? 0) / staging.expectedFiles : null;
    return {
      description, ratio: ratio === null ? null : Math.min(1, ratio),
      receivedFiles: staging.receivedFiles ?? 0, expectedFiles: staging.expectedFiles, receivedBytes, totalBytes,
    };
  }
  const applied = ['transitioning', 'saving', 'watching'].includes(session.status);
  return { description, ratio: applied ? 1 : null, totalBytes };
}
