import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { observeProcessClose, terminateProcess } from '../../agent/environment.js';
import { privateDirectory, readPrivateJson, writePrivateJson } from '../credential-files.js';
import { probeEnvironment, type Probe } from '../usage-probes.js';

// Python's standard library gives the CLI a controlling terminal without a Node native addon; bytes pass through unchanged.
const terminalRelay = String.raw`
import errno, fcntl, os, select, signal, struct, sys, termios

pid, master = os.forkpty()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
source = sys.stdin.fileno()
try:
    while True:
        readers, _, _ = select.select([master, source], [], [])
        if master in readers:
            try:
                output = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                output = b''
            if not output:
                break
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        if source in readers:
            data = os.read(source, 65536)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
`;

const STARTUP_TIMEOUT = 45_000;
const STARTUP_QUIET = 2_000;
const ECHO_TIMEOUT = 8_000;
const WALL_TIMEOUT = 90_000;
const RESULT_TIMEOUT = 60_000;
// A cheap model keeps the cost negligible should the account turn out not to be at its limit after all.
const PROBE_PROMPT = 'Reply with OK.';

export type ClaudeResetOutcome = 'reset' | 'spent' | 'not_offered' | 'unavailable' | 'login' | 'busy' | 'no_wall'
  | 'unsupported' | 'unknown';

export interface ClaudeResetResult { outcome: ClaudeResetOutcome; message: string; detail: string | null }

const MESSAGES: Record<ClaudeResetOutcome, string> = {
  reset: '已重置 5 小时额度，仍计入每周额度',
  spent: '本周的 5 小时额度重置已经用过',
  not_offered: 'Claude Code 当前没有为该账号提供 5 小时额度重置',
  unavailable: 'Claude Code 暂时无法重置，请稍后再试',
  login: '槽位的登录无法用于重置，请重新登录该槽位',
  busy: '该账号正在重置，请稍后刷新额度',
  no_wall: '没有收到 5 小时额度用尽的提示，未执行重置',
  unsupported: '该账号的重置需要在终端中选择重置卡，网页暂不支持，已取消且未使用',
  unknown: 'Claude Code 返回了无法识别的结果，请刷新额度确认是否已重置',
};

// The CLI's default wording. Its configuration may replace these texts, which then end as `unknown`.
const RESULTS: [string, ClaudeResetOutcome][] = [
  ["isn'tavailablerightnow", 'not_offered'],
  ['alreadybeingreset', 'busy'],
  ['withthislogin', 'login'],
  ["couldn'tresetyoursessionlimit", 'unavailable'],
  ['weeklyresetused', 'spent'],
  ['sessionlimitreset', 'reset'],
];
// Banked resets ask which one to use; the page cannot answer, so the run backs out without choosing.
const PICKERS = ['whichresetdoyouwanttouse', 'yes,usemy', 'no,keepit'];

/** Text the terminal shows: cursor moves within a line kept as spaces, other control sequences dropped. */
function visibleText(raw: string): string {
  // The CLI places words by moving forward or to an absolute column instead of writing spaces.
  return raw.replace(/\x1b\[(\d*)C/g, (_, count: string) => ' '.repeat(Number(count || 1))).replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]/g, '')
    .replace(/\r\n?/g, '\n');
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, '');
}

class TerminalTranscript {
  private raw = '';
  private lastOutput = 0;
  private exited = false;
  private listeners = new Set<() => void>();

  constructor(private child: ChildProcessWithoutNullStreams) {
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      this.raw += decoder.write(chunk);
      this.lastOutput = Date.now();
      for (const listener of this.listeners) listener();
    });
    child.once('close', () => { this.exited = true; for (const listener of this.listeners) listener(); });
  }

  mark(): number { return this.raw.length; }

  text(from = 0): string { return visibleText(this.raw.slice(from)); }

  write(data: string): void { this.child.stdin.write(data); }

  /** Resolves with the first value `match` finds in the output since `from`, or undefined on timeout. */
  waitFor<T>(from: number, timeout: number, match: (compacted: string) => T | undefined): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = match(compact(this.text(from)));
        if (found !== undefined) return finish(() => resolve(found));
        if (this.exited) finish(() => reject(new Error(`Claude Code 已退出：${this.tail()}`)));
      };
      const timer = setTimeout(() => finish(() => resolve(undefined)), timeout);
      const finish = (settle: () => void) => { clearTimeout(timer); this.listeners.delete(check); settle(); };
      this.listeners.add(check);
      check();
    });
  }

  /** Waits for the first output followed by a pause, so animations and start-up dialogs have settled. */
  async settle(quiet: number, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`Claude Code 已退出：${this.tail()}`);
      if (this.lastOutput && Date.now() - this.lastOutput >= quiet) return;
      await pause(200);
    }
  }

  /** The last lines on screen, for errors that need to show where the CLI stopped. */
  tail(from = 0): string {
    return this.text(from).split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join(' / ').slice(0, 300);
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// A command's reply is drawn under it after "⎿"; the last one is the reset's own answer.
function commandReply(text: string): string | null {
  const replies = text.split('\n').filter(line => line.includes('⎿'));
  const reply = replies.at(-1)?.split('⎿').at(-1)?.replace(/\s+/g, ' ').trim();
  return reply ? reply.slice(0, 300) : null;
}

/** The isolated home skips first-run screens and trusts the empty working directory. */
async function prepareConfiguration(home: string, workspace: string): Promise<void> {
  // The deployment's run directory is a symlink; use one canonical root for the containment check.
  const actualHome = await realpath(home);
  const file = join(actualHome, '.claude', '.claude.json');
  const current = JSON.parse(await readPrivateJson(file, actualHome) ?? '{}');
  await writePrivateJson(file, JSON.stringify({
    ...current, hasCompletedOnboarding: true, theme: current.theme ?? 'dark',
    projects: { [workspace]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));
}

/**
 * Claude Code offers its weekly 5-hour reset only inside an interactive session that has itself been refused at
 * the 5-hour limit, so the run drives one in a terminal: it sends a message the limit refuses, then uses /limit-reset.
 */
export async function claudeLimitReset(probe: Probe): Promise<ClaudeResetResult> {
  const workspace = join(probe.home, 'limit-reset');
  await privateDirectory(workspace);
  await prepareConfiguration(probe.home, workspace);
  const child = await probe.execution.spawn('python3', ['-I', '-c', terminalRelay, probe.binary, '--model', 'haiku',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
  { scope: probe.scope, cwd: workspace, env: probeEnvironment(probe) });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const terminal = new TerminalTranscript(child);
  const result = (outcome: ClaudeResetOutcome, detail: string | null = null): ClaudeResetResult =>
    ({ outcome, message: MESSAGES[outcome], detail });
  try {
    await terminal.settle(STARTUP_QUIET, STARTUP_TIMEOUT);
    let from = terminal.mark();
    terminal.write(PROBE_PROMPT);
    if (!await terminal.waitFor(from, ECHO_TIMEOUT, text => text.includes(compact(PROBE_PROMPT)) || undefined)) {
      throw new Error(`Claude Code 启动后没有进入输入状态：${terminal.tail()}`);
    }
    from = terminal.mark();
    terminal.write('\r');
    // A reply is drawn after a bullet, which the CLI picks per platform.
    const wall = await terminal.waitFor(from, WALL_TIMEOUT, text => text.includes("you'vehityour") ? 'limited' as const
      : /[⏺●]ok/.test(text) ? 'answered' as const : undefined);
    if (wall !== 'limited') return result('no_wall');
    // Reaching the limit opens the CLI's options menu; leaving it returns to the prompt where the command is typed.
    await terminal.settle(STARTUP_QUIET, 10_000);
    terminal.write('\x1b');
    await pause(1_000);
    from = terminal.mark();
    terminal.write('/limit-reset');
    if (!await terminal.waitFor(from, ECHO_TIMEOUT, text => text.includes('/limit-reset') || undefined)) {
      throw new Error(`无法在 Claude Code 中输入 /limit-reset：${terminal.tail(from)}`);
    }
    await pause(800);
    from = terminal.mark();
    terminal.write('\r');
    const outcome = await terminal.waitFor(from, RESULT_TIMEOUT, text =>
      PICKERS.some(marker => text.includes(marker)) ? 'unsupported' as const
        : RESULTS.find(([marker]) => text.includes(marker))?.[1]);
    if (outcome === 'unsupported') {
      terminal.write('\x1b');
      await pause(1_000);
      return result('unsupported');
    }
    return result(outcome ?? 'unknown', commandReply(terminal.text(from)) ?? (outcome ? null : terminal.tail(from)));
  } finally {
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}
