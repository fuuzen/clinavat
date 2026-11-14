import { randomUUID } from 'node:crypto';
import { parseCodexRead, type UsageUpdate } from '../usage-parsers.js';
import { withCodexServer, type Probe } from '../usage-probes.js';

export type CodexResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

const MESSAGES: Record<CodexResetOutcome, string> = {
  reset: '已使用 1 张重置卡，额度已重置',
  nothingToReset: '当前没有可重置的额度窗口，重置卡未使用',
  noCredit: '该账号没有可用的重置卡',
  alreadyRedeemed: '这次重置已经完成',
};

/** Spends one earned reset; without `creditId` the service picks the next available one. */
export async function codexLimitReset(probe: Probe, creditId?: string): Promise<{
  outcome: CodexResetOutcome; message: string; usage: UsageUpdate;
}> {
  return withCodexServer(probe, async rpc => {
    const { outcome } = await rpc.request('account/rateLimitResetCredit/consume',
      { idempotencyKey: randomUUID(), creditId: creditId ?? null }, 60_000) as { outcome: CodexResetOutcome };
    if (!(outcome in MESSAGES)) throw new Error(`Codex 返回了未知的重置结果：${String(outcome)}`);
    // The service asks clients to read the limits again once a reset is consumed.
    const usage = parseCodexRead(await rpc.request('account/rateLimits/read', {}, 30_000));
    return { outcome, message: MESSAGES[outcome], usage };
  });
}
