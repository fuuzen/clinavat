import type { AgentConfig } from './types.js';
import type { ActiveRun } from './manager.js';
import type { ResidentUsage, UsageSlot } from '../accounts/usage.js';

/** A live CLI owns its auth and refresh locks; never replace a failed read with a second CLI. */
export async function readResidentUsage(runs: Map<string, ActiveRun>, config: AgentConfig,
  slot: UsageSlot): Promise<ResidentUsage | undefined> {
  const matches = [...runs.values()].filter(state => state.slotId === slot.id
    && state.context.slot.engine === slot.engine && (state.run || state.cliStarting));
  if (!matches.length) return undefined;
  const usable = (state: ActiveRun) => runs.get(state.context.session.id) === state && !!state.run
    && !state.finishing && !state.closing && !state.abort.signal.aborted
    && state.control.state === 'running' && state.context.slot.home_dir === slot.home_dir;
  // An idle resident has no model request to compete with; either one uses the same slot identity.
  const state = matches.filter(usable).sort((left, right) => Number(left.turnActive) - Number(right.turnActive))[0];
  if (!state?.run) throw new Error('槽位 CLI 正在启动、暂停或退出，稍后再读取额度');
  const run = state.run;
  const identity = state.context.account_identity;
  const assertCurrent = async () => {
    if (!usable(state)) throw new Error('读取额度期间槽位 CLI 状态发生变化，请稍后重试');
    await config.credentials.fingerprint(state.context);
    if (!identity || await config.usage?.captureIdentity(slot) !== identity) {
      throw new Error('运行中 CLI 与槽位当前账号身份不一致，请重新启动对话后刷新额度');
    }
    if (!usable(state)) throw new Error('读取额度期间槽位 CLI 状态发生变化，请稍后重试');
  };
  await assertCurrent();
  const update = await run.readUsage();
  await assertCurrent();
  return { update, identity: identity! };
}
