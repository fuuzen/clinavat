export interface CommitTaskContext { code: string; title: string; description?: string | null }
export interface ChangedFileEntry { status: string; path: string }

export interface CommitContext {
  agentName?: string | null;
  branch?: string | null;
  task?: CommitTaskContext | null;
  report?: string | null;
  commitMessage?: string | null;
}

export interface BuildCommitMessageOptions extends CommitContext {
  kind: 'settle' | 'merge' | 'squash';
  files?: ChangedFileEntry[];
}

const MAX_HEADER_LENGTH = 72;
const MAX_SCOPE_LENGTH = 20;
const MAX_LISTED_FILES = 15;
const CONVENTIONAL_TYPES = new Set(['feat', 'fix', 'refactor', 'docs', 'ci', 'chore', 'perf', 'build', 'test', 'style']);
const CONVENTIONAL_HEADER_RE = /^(feat|fix|refactor|docs|ci|chore|perf|build|test|style)(?:\(([^)\s]+)\))?(!)?:\s*(.+)$/i;
const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/;
const GENERIC_DIR_SEGMENTS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'pkg', 'internal', 'common', 'shared', 'utils', 'index', '.']);

const TYPE_RULES: Array<{ type: string; pattern: RegExp }> = [
  { type: 'fix', pattern: /\b(?:fix(?:es|ed)?|bug(?:fix)?|hotfix|patch|repair|crash|broken|regression|error)\b|修复|修正|缺陷|补丁|崩溃|报错|故障|回归/i },
  { type: 'refactor', pattern: /\b(?:refactor(?:s|ed|ing)?|restructure|split|extract|decouple|simplify|reorganize|modularize|cleanup)\b|重构|拆分|解耦|整理|抽离|模块化|精简/i },
  { type: 'perf', pattern: /\b(?:perf|performance|optimi[sz]e|latency|throughput|faster|memory)\b|性能优化|优化性能|提速|降耗/i },
  { type: 'docs', pattern: /\b(?:docs?|documentation|readme|changelog|guide)\b|文档|说明文档|手册/i },
  { type: 'ci', pattern: /\b(?:ci|workflow|pipeline|github\s+actions?)\b|持续集成|工作流|流水线|发布流程/i },
  { type: 'build', pattern: /\b(?:build|bundle|deps|dependencies|dockerfile|compose|packaging|upgrade|bump)\b|构建|打包|依赖升级|镜像/i },
  { type: 'feat', pattern: /\b(?:feat(?:ure)?|add(?:s|ed)?|implement(?:s|ed)?|introduce|support|create|enable|extend|norma[li]ize)\b|新增|实现|支持|添加|引入|扩展|规范化|功能/i },
  { type: 'chore', pattern: /\b(?:chore|maintenance|sync|config|lint|format)\b|杂项|维护|配置|清理/i },
];

function cleanText(raw: string): string {
  return raw.replace(/\0/g, '').replace(/\r\n?/g, '\n');
}

function truncateLine(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  if (maxLength <= 3) return trimmed.slice(0, maxLength);
  const target = maxLength - 3;
  const sliced = trimmed.slice(0, target);
  const lastSpace = sliced.lastIndexOf(' ');
  const candidate = lastSpace >= Math.floor(target * 0.6) ? sliced.slice(0, lastSpace) : sliced;
  return `${candidate.replace(/[\s,.;:，。；：-]+$/, '') || sliced.trimEnd()}...`;
}

function sanitizeScope(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^[-._/]+|[-._/]+$/g, '');
  if (!cleaned || cleaned.length > MAX_SCOPE_LENGTH || GENERIC_DIR_SEGMENTS.has(cleaned)) return undefined;
  return cleaned;
}

function stripTaskPrefix(text: string): string {
  return text.replace(/^(?:\[?T\d+\]?[:：\s-]+)+/i, '').trim();
}

function parseConventionalPrefix(text: string): { type?: string; scope?: string; subject: string } {
  const cleaned = stripTaskPrefix(text).replace(/\s+/g, ' ').trim();
  const match = CONVENTIONAL_HEADER_RE.exec(cleaned);
  if (!match) return { subject: cleaned };
  const type = match[1].toLowerCase();
  const scope = sanitizeScope(match[2]);
  return {
    type: CONVENTIONAL_TYPES.has(type) ? type : undefined,
    scope,
    subject: match[4].trim(),
  };
}

function inferTypeFromFiles(files: ChangedFileEntry[]): string | undefined {
  if (!files.length) return undefined;
  const paths = files.map(file => file.path.replace(/\\/g, '/'));
  if (paths.every(p => /(?:^|\/)(?:docs\/|readme|changelog|license)|\.mdx?$/i.test(p))) return 'docs';
  if (paths.every(p => /^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\/|jenkinsfile/i.test(p))) return 'ci';
  if (paths.every(p => /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/i.test(p))) return 'test';
  if (paths.every(p => /(?:^|\/)(?:dockerfile[^/]*|docker-compose[^/]*|makefile|package(?:-lock)?\.json|pnpm-lock\.yaml|cargo\.(?:toml|lock)|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/i.test(p))) {
    return 'build';
  }
  return undefined;
}

function inferScopeFromFiles(files: ChangedFileEntry[]): string | undefined {
  if (!files.length) return undefined;
  const dirLists = files.map(file => {
    const parts = file.path.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
    const dirs = parts.length > 1 ? parts.slice(0, -1) : [];
    return dirs.filter(seg => !GENERIC_DIR_SEGMENTS.has(seg.toLowerCase()));
  }).filter(dirs => dirs.length > 0);
  if (!dirLists.length) return undefined;

  const common: string[] = [];
  const minLen = Math.min(...dirLists.map(list => list.length));
  for (let i = 0; i < minLen; i++) {
    const seg = dirLists[0][i];
    if (dirLists.every(list => list[i] === seg)) common.push(seg);
    else break;
  }
  for (let i = common.length - 1; i >= 0; i--) {
    const scope = sanitizeScope(common[i]);
    if (scope) return scope;
  }

  const counts = new Map<string, number>();
  for (const dirs of dirLists) {
    const first = sanitizeScope(dirs[0]);
    if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] / dirLists.length >= 0.7) return ranked[0][0];
  return undefined;
}

function stripReportNoise(report: string): string[] {
  const withoutWorktree = cleanText(report)
    .replace(/\n*\[worktree\][\s\S]*$/i, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<\/?[a-z_][a-z0-9_-]*[^>]*>/gi, '');
  const lines: string[] = [];
  for (const rawLine of withoutWorktree.split('\n')) {
    const line = rawLine
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim();
    if (!line || /^[-=_]{3,}$/.test(line)) continue;
    if (/^(?:子智能体没有给出最终回复|子智能体已被停止|子智能体的执行被中断|子智能体出错)/.test(line)) continue;
    if (/^(?:summary|conclusion|result|changed files?|verification|总结|结论|变更文件|验证)[:：]?$/i.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function inferType(options: BuildCommitMessageOptions, files: ChangedFileEntry[], parsedTitle: { type?: string }): string {
  if (parsedTitle.type) return parsedTitle.type;
  const fileType = inferTypeFromFiles(files);
  if (fileType && fileType !== 'build') return fileType;

  const corpus = [
    options.task?.title ?? '',
    options.task?.description?.slice(0, 300) ?? '',
    stripReportNoise(options.report ?? '').slice(0, 3).join(' '),
    options.agentName ?? '',
    options.branch ?? '',
  ].join('\n');

  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(corpus)) return rule.type;
  }
  if (fileType) return fileType;
  if (files.some(file => file.status === 'A' || file.status === '?')) return 'feat';
  return 'chore';
}

function dedupeFiles(files: ChangedFileEntry[] = []): ChangedFileEntry[] {
  const byPath = new Map<string, ChangedFileEntry>();
  for (const file of files) {
    const cleanPath = cleanText(file.path).trim();
    if (!cleanPath) continue;
    const status = file.status.trim().toUpperCase().slice(0, 1) || 'M';
    if (!byPath.has(cleanPath)) byPath.set(cleanPath, { status, path: cleanPath });
  }
  return [...byPath.values()];
}

function buildTrailers(context: Pick<CommitContext, 'task' | 'agentName'>): Array<{ key: string; line: string }> {
  const trailers: Array<{ key: string; line: string }> = [];
  const taskCode = context.task?.code?.trim().replace(/[\r\n\0]+/g, ' ');
  const agentName = context.agentName?.trim().replace(/[\r\n\0]+/g, ' ');
  if (taskCode) trailers.push({ key: 'clinavat-task', line: `Clinavat-Task: ${taskCode}` });
  if (agentName) trailers.push({ key: 'clinavat-agent', line: `Clinavat-Agent: ${agentName}` });
  return trailers;
}

function appendTrailers(message: string, context: Pick<CommitContext, 'task' | 'agentName'>): string {
  const desired = buildTrailers(context);
  if (!desired.length) return message;

  const paragraphs = message.split(/\n{2,}/);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? '';
  const lastLines = lastParagraph.split('\n').filter(Boolean);
  const hasTrailerBlock = paragraphs.length > 1 && lastLines.length > 0 && lastLines.every(line => TRAILER_LINE_RE.test(line));

  const existingKeys = new Set<string>();
  if (hasTrailerBlock) {
    for (const line of lastLines) {
      const match = TRAILER_LINE_RE.exec(line);
      if (match) existingKeys.add(match[1].toLowerCase());
    }
  } else {
    for (const line of message.split('\n')) {
      const match = TRAILER_LINE_RE.exec(line);
      if (match && (match[1].toLowerCase() === 'clinavat-task' || match[1].toLowerCase() === 'clinavat-agent')) {
        existingKeys.add(match[1].toLowerCase());
      }
    }
  }

  const missing = desired.filter(entry => !existingKeys.has(entry.key)).map(entry => entry.line);
  if (!missing.length) return message;

  if (hasTrailerBlock) {
    paragraphs[paragraphs.length - 1] = [...lastLines, ...missing].join('\n');
    return paragraphs.join('\n\n');
  }
  return `${message}\n\n${missing.join('\n')}`;
}

/** Normalizes a caller-supplied commit message while preserving multi-paragraph bodies and trailers. */
export function normalizeCommitMessage(rawMessage: string, context: Pick<CommitContext, 'task' | 'agentName'> = {}): string {
  const normalized = cleanText(rawMessage)
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';
  const lines = normalized.split('\n');
  const header = truncateLine(lines[0], MAX_HEADER_LENGTH);
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
  const combined = rest ? `${header}\n\n${rest}` : header;
  return appendTrailers(combined, context);
}

function buildFilesSection(files: ChangedFileEntry[]): string | undefined {
  if (!files.length) return undefined;
  const shown = files.slice(0, MAX_LISTED_FILES).map(file => `- ${file.status} ${file.path}`);
  const remaining = files.length - shown.length;
  if (remaining > 0) shown.push(`... and ${remaining} more files`);
  return `Changed files:\n${shown.join('\n')}`;
}

function buildSummaryParagraph(options: BuildCommitMessageOptions, subject: string, reportLines: string[]): string | undefined {
  const parts: string[] = [];
  const taskDesc = options.task?.description ? cleanText(options.task.description).replace(/\s+/g, ' ').trim() : '';
  if (taskDesc && taskDesc !== subject) parts.push(truncateLine(taskDesc, 220));

  const reportSummary = reportLines
    .filter(line => line !== subject && !subject.includes(line))
    .slice(0, 2)
    .map(line => truncateLine(line, 180));
  parts.push(...reportSummary);

  if (!parts.length && options.branch && options.kind !== 'settle') {
    parts.push(`${options.kind === 'squash' ? 'Squash' : 'Merge'} branch ${options.branch}.`);
  }
  return parts.length ? parts.join('\n') : undefined;
}

/** Generates a Conventional Commit message (or normalizes an explicit one) with Clinavat trailers. */
export function buildCommitMessage(options: BuildCommitMessageOptions): string {
  if (options.commitMessage?.trim()) {
    const normalized = normalizeCommitMessage(options.commitMessage, options);
    if (normalized) return normalized;
  }

  const files = dedupeFiles(options.files);
  const reportLines = stripReportNoise(options.report ?? '');
  const parsedTitle = options.task?.title?.trim()
    ? parseConventionalPrefix(options.task.title)
    : reportLines.length
      ? parseConventionalPrefix(reportLines[0])
      : { subject: '' };

  const type = inferType(options, files, parsedTitle);
  const rawScope = parsedTitle.scope ?? inferScopeFromFiles(files);
  const scope = rawScope && rawScope !== type ? rawScope : undefined;
  const prefix = `${type}${scope ? `(${scope})` : ''}: `;

  let rawSubject = parsedTitle.subject;
  if (!rawSubject) {
    if (files.length === 1) rawSubject = `update ${files[0].path.split('/').pop() ?? files[0].path}`;
    else if (options.agentName) rawSubject = `${options.kind === 'settle' ? 'apply' : options.kind} ${options.agentName} changes`;
    else if (options.branch) rawSubject = `${options.kind === 'settle' ? 'apply' : options.kind} ${options.branch}`;
    else rawSubject = 'apply worktree changes';
  }
  const cleanSubject = rawSubject.replace(/\s+/g, ' ').replace(/[.。:：;；]+$/, '').trim() || 'apply worktree changes';
  const header = `${prefix}${truncateLine(cleanSubject, Math.max(12, MAX_HEADER_LENGTH - prefix.length))}`;

  const sections = [header];
  const summary = buildSummaryParagraph(options, cleanSubject, reportLines);
  if (summary) sections.push(summary);
  const filesSection = buildFilesSection(files);
  if (filesSection) sections.push(filesSection);

  return appendTrailers(sections.join('\n\n'), options);
}
