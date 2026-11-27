import type { AgentEngine } from '../engines.js';
import type { AgentConfig, AgentContext } from '../types.js';

export type BtwStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface BtwExchange {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  status: BtwStatus;
  error: string | null;
  engine: AgentEngine;
  model: string | null;
  slot_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BtwHistoryEntry {
  question: string;
  response: string;
}

export interface BtwEventPayload {
  action: 'upsert' | 'delta' | 'delete';
  exchange?: BtwExchange;
  id?: string;
  delta?: string;
}

export interface BtwEngineInput {
  config: AgentConfig;
  context: AgentContext;
  question: string;
  history: BtwHistoryEntry[];
  snapshot: string;
  signal: AbortSignal;
  onDelta(chunk: string): void;
  onProgress?(event: Record<string, unknown>): void;
}
