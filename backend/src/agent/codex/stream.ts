import { randomUUID } from 'node:crypto';
import type { RunServices } from '../types.js';

const TEXT_LIMIT = 8 * 1024 * 1024;

/**
 * Tracks a Codex turn's streamed text, reasoning, retry notice, and mid-turn steering epochs.
 * When Codex consumes a steered `userMessage`, the epoch advances so subsequent reasoning and
 * agent messages get fresh item IDs and never append to or finalize pre-steer items.
 */
export class CodexTurnStream {
  private messages = new Map<string, string>();
  private phases = new Map<string, string>();
  private currentAnswerIds = new Set<string>();
  private itemEpochs = new Map<string, number>();
  private pendingSteers = new Set<string>();
  private steerEpoch = 0;
  private textSize = 0;
  private retry: { id: string; text: string } | undefined;

  constructor(private services: RunServices) {}

  queueSteer(messageId: string): void {
    this.pendingSteers.add(messageId);
  }

  cancelSteer(messageId: string): void {
    this.pendingSteers.delete(messageId);
  }

  resetAnswer(): void {
    this.currentAnswerIds.clear();
  }

  resetTurn(): void {
    this.messages.clear();
    this.phases.clear();
    this.currentAnswerIds.clear();
    this.itemEpochs.clear();
    this.pendingSteers.clear();
    this.steerEpoch = 0;
    this.textSize = 0;
  }

  recordRetry(text: string): void {
    this.retry = { id: this.retry?.id ?? `retry:${randomUUID()}`, text };
    this.services.event('activity', { id: this.retry.id, kind: 'notice', text: `${text}（正在重试）` });
  }

  settleRetry(outcome: string): void {
    if (this.retry) this.services.event('activity', { id: this.retry.id, kind: 'notice', text: `${this.retry.text}（${outcome}）` });
    this.retry = undefined;
  }

  /** Consumes a pending steer when Codex emits its `userMessage` item; returns true when matched. */
  consumeUserMessage(item: Record<string, any> | undefined): boolean {
    if (item?.type !== 'userMessage') return false;
    const clientId = typeof item.clientId === 'string' ? item.clientId : '';
    if (!clientId || !this.pendingSteers.has(clientId)) return false;
    this.pendingSteers.delete(clientId);
    this.steerEpoch += 1;
    this.messages.clear();
    this.phases.clear();
    this.currentAnswerIds.clear();
    this.itemEpochs.clear();
    this.services.steered(clientId);
    return true;
  }

  onAgentMessageDelta(params: Record<string, any>): boolean {
    const text = String(params.delta ?? '');
    if (this.textSize + text.length > TEXT_LIMIT) return false;
    const id = this.scopedId(String(params.itemId ?? 'partial'));
    this.currentAnswerIds.add(id);
    this.messages.set(id, (this.messages.get(id) ?? '') + text);
    this.textSize += text.length;
    this.services.event('activity', { id, kind: 'text', text, append: true });
    return true;
  }

  onReasoningDelta(params: Record<string, any>): void {
    const base = this.scopedId(String(params.itemId ?? 'reasoning'));
    this.services.event('activity', {
      id: `${base}:summary:${params.summaryIndex ?? 0}`, kind: 'reasoning',
      text: String(params.delta ?? ''), append: true,
    });
  }

  onItemStarted(item: Record<string, any> | undefined): void {
    if (this.consumeUserMessage(item)) return;
    if (item?.type === 'agentMessage' && item.id !== undefined) {
      const id = this.scopedId(String(item.id));
      if (typeof item.phase === 'string') this.phases.set(id, item.phase);
    } else if (item?.type === 'reasoning' && item.id !== undefined) {
      this.scopedId(String(item.id));
    }
  }

  /** Returns false if the accumulated text exceeds the turn text limit. */
  onItemCompleted(item: Record<string, any> | undefined): boolean {
    if (this.consumeUserMessage(item)) return true;
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      const id = this.scopedId(String(item.id));
      this.currentAnswerIds.add(id);
      this.textSize += item.text.length - (this.messages.get(id)?.length ?? 0);
      if (this.textSize > TEXT_LIMIT) return false;
      this.messages.set(id, item.text);
      if (typeof item.phase === 'string') this.phases.set(id, item.phase);
      this.services.event('activity', { id, kind: 'text', text: item.text });
    }
    if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
      const base = this.scopedId(String(item.id));
      item.summary.forEach((text: unknown, index: number) => {
        if (typeof text === 'string') this.services.event('activity', { id: `${base}:summary:${index}`, kind: 'reasoning', text });
      });
    }
    return true;
  }

  finalAnswer(failed: boolean, stopped: boolean): string {
    const explicitFinal = [...this.currentAnswerIds].filter(id => this.phases.get(id) === 'final_answer');
    const unclassified = [...this.currentAnswerIds].filter(id => !this.phases.has(id));
    const finalIds = explicitFinal.length ? explicitFinal : !failed && !stopped ? unclassified.slice(-1) : [];
    for (const id of finalIds) this.services.event('activity', { id, kind: 'text', text: this.messages.get(id) || '', final: true });
    const text = finalIds.map(id => this.messages.get(id)).join('\n\n').trim();
    return text || (this.services.context.session.command === 'compact' && !failed && !stopped
      ? '原生上下文已压缩。网页中的历史消息仍会保留。' : '');
  }

  private scopedId(rawId: string): string {
    let epoch = this.itemEpochs.get(rawId);
    if (epoch === undefined) {
      epoch = this.steerEpoch;
      this.itemEpochs.set(rawId, epoch);
    }
    return epoch ? `s${epoch}:${rawId}` : rawId;
  }
}
