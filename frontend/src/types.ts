export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  created_at: string;
  /** Set while an administrator has suspended the account. */
  suspended_at?: string | null;
  ssh_public_key?: string;
}

export interface Slot {
  id: string;
  label: string;
  engine: "claude" | "codex";
  status: "IDLE" | "RATE_LIMITED" | "DISABLED";
  auth_method: "oauth" | "token";
  token_expires_at?: string | null;
  /** When the slot's model catalog was last read from its CLI. */
  model_catalog_at?: string | null;
  allowed_user_ids?: string[];
  max_concurrent_users: 1;
  in_use: boolean;
  in_use_by_you: boolean;
  active_user_id?: string | null;
  home_dir?: string;
  credential_revision: number;
  updated_at: string;
}

export interface DevHost {
  id: string;
  kind?: "local" | "ssh";
  name: string;
  host: string;
  port: number;
  username: string;
  status: string;
  fingerprint?: string;
  jump_host?: string | null;
  jump_port?: number | null;
  jump_username?: string | null;
}

export interface Project {
  id: string;
  name: string;
  dev_host_id: string;
  remote_path: string;
  local_path: string;
  path_mode: "auto" | "direct" | "bwrap" | "symlink";
  execution_mode: "local" | "direct" | "bwrap" | "symlink" | null;
  sync_status: string;
  /** JSON of SkippedLinks, the symbolic links the sync last reported as skipped; null when there are none. */
  sync_skipped_links?: string | null;
}

export interface SkippedLink {
  /** alpha is the dev machine, beta the mirror on the pool machine. */
  side: "alpha" | "beta";
  path: string;
  reason: string;
}

export interface SkippedLinks {
  links: SkippedLink[];
  /** Skipped links Mutagen did not list individually. */
  more: number;
}

export interface Session {
  id: string;
  project_id: string;
  engine: "claude" | "codex";
  slot_mode: SlotMode;
  slot_id: string | null;
  title: string;
  status: string;
  updated_at: string;
  model?: string | null;
  reasoning_effort?: string | null;
  permission_mode?: PermissionMode;
  agent_mode?: AgentMode;
  role_preset?: RolePreset;
  question_mode?: QuestionMode | null;
  question_timeout_ms?: number | null;
  /** Archived conversations are read-only and listed apart until restored. */
  archived_at?: string | null;
  forked_from_session_id?: string | null;
  forked_from_turn_id?: string | null;
}

/** What happens to a question nobody answers in time. */
export type QuestionMode = "skip" | "defer";
export interface QuestionPolicy {
  mode: QuestionMode;
  timeoutMs: number;
}
/** A field left null follows the next level of defaults. */
export interface QuestionPreference {
  mode: QuestionMode | null;
  timeoutMs: number | null;
}

export type SlotMode = "manual" | "auto";
export interface AccountSelection {
  engine: Session["engine"];
  slotMode: SlotMode;
  slotId?: string;
}

export type PermissionMode = "manual" | "accept-edits" | "auto" | "full-access" | "yolo";
export type AgentMode = "normal" | "plan";
export type RolePreset = "default" | "reviewer" | "architect";
export interface AgentBehavior {
  agentMode: AgentMode;
  rolePreset: RolePreset;
}

export interface AgentSelection {
  model: string | null;
  reasoningEffort: string | null;
}

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: { value: string; label: string }[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

/** A user's own model and reasoning effort for conversations that leave them to the default. */
export interface AgentPreference {
  model: string | null;
  reasoningEffort: string | null;
  /** What the user's new conversations start with; null follows the site's default. */
  permissionMode: PermissionMode | null;
}

export type AgentPreferences = Record<"claude" | "codex", AgentPreference>;

/** A slot's saved model list and when it was read from the slot's CLI. */
export interface ModelCatalog {
  models: AgentModel[];
  refreshedAt: string;
}

export interface Message {
  id: string;
  session_id?: string;
  role: string;
  content: string;
  /** IDs of the images attached to a user message, as JSON; null when there are none. */
  images?: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  session_id: string;
  tool: string;
  input: unknown;
  status: string;
  created_at: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  status?: string;
  /** The subagent that made the call; absent for the conversation's own agent. */
  agent?: string;
}

export interface ActivityItem {
  id: string;
  kind: "text" | "reasoning" | "tool";
  text?: string;
  tool?: ToolEvent;
  final?: boolean;
}

export interface Turn {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id?: string | null;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  paused_at?: string | null;
  paused_ms?: number;
  slot_id?: string | null;
  credential_revision?: number | null;
  status: "running" | "pausing" | "paused" | "completed" | "interrupted" | "error";
  items: ActivityItem[];
  /** Where the turn ends in the CLI's history; only turns that have one can be branched from. */
  native_ref?: string | null;
}

export interface Overview {
  user: User;
  slots: Slot[];
  hosts: DevHost[];
  projects: Project[];
  sessions: Session[];
  questionDefaults: QuestionPolicy;
  agentDefaults: AgentPreferences;
  deferredQuestions: { session_id: string; count: number }[];
}

export interface PoolEvent {
  type: string;
  sessionId?: string;
  payload?: Record<string, unknown> | string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  limited?: boolean;
}

export interface SlotUsage {
  slotId: string;
  state: "pending" | "ok" | "error" | "unavailable";
  plan: string | null;
  windows: UsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  limited: boolean | null;
  observedAt: string | null;
  /** When the reading stops counting as current; set by the administrator's validity period. */
  expiresAt: string | null;
  checkedAt: string | null;
  source: "query" | "event" | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
  subscription: SlotSubscription | null;
  login: SlotLogin | null;
}

/** How often idle slots are queried, and how long a reading stays current. */
export interface UsageSettings {
  refreshIntervalMs: number;
  staleAfterMs: number;
}

/** Only long-lived tokens have a fixed end; a browser login's access token is renewed by the CLI while the login lasts. */
export interface SlotLogin {
  method: "oauth" | "token" | "apikey" | "none";
  expiresAt: string | null;
  accessExpiresAt: string | null;
  refreshedAt: string | null;
}

/** Read from the slot's login files: Codex states when the paid period ends, Claude only when it began. */
export interface SlotSubscription {
  plan: string | null;
  tier: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
}

export interface SyncScanEntry {
  path: string;
  type: "file" | "directory";
  bytes: number;
  files: number;
  tracked: boolean | null;
}

export interface SyncScanLink {
  path: string;
  target: string;
  kind: "project" | "workspace" | "outside" | "invalid";
}

export interface SyncScan {
  remotePath: string;
  totalBytes: number;
  totalFiles: number;
  entries: SyncScanEntry[];
  links: SyncScanLink[];
  linkCount: number;
  truncated: boolean;
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

export interface ProjectUsage {
  mirrorBytes: number | null;
}

export interface SyncRules {
  rules: string;
  /** Built-in patterns that apply to every project, in addition to the project's own rules. */
  defaults: string[];
}

export interface GitState {
  branch: string;
  status: string;
  diff: string;
}

/** How a message sent during a running reply is handled. */
export type InputMode = "steer" | "queue" | "interrupt";
export interface RuntimeTask { id: string; description: string; type: string }
/** The conversation's resident CLI process, as reported by the Hub. */
export interface SessionRuntime {
  resident: boolean;
  turnActive: boolean;
  queue: { id: string; content: string; queuedAt: string; images?: number }[];
  tasks: RuntimeTask[];
  switching?: { fromSlotId: string; attempt: number; targetSlotId?: string };
  settling?: boolean;
}

/** Tokens and API-price cost per user, slot and model over a period; `unpriced` records lack a known price. */
export interface TokenUsageRow {
  user_id: string;
  username: string | null;
  slot_id: string;
  slot_label: string | null;
  engine: "claude" | "codex";
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  unpriced: number;
  last_used_at: string;
}

export interface TokenUsageReport {
  days: number;
  priceSnapshotDate: string;
  rows: TokenUsageRow[];
}

/** USD per million tokens: input, cache read, cache write, output; a missing cache price uses the input price. */
export type ModelPrice = [number, number | null, number | null, number];

export interface ModelPriceList {
  snapshot: { source: "bundled" | "imported"; date: string; models: number };
  entries: { model: string; price: ModelPrice; snapshot: ModelPrice | null; custom: boolean }[];
  /** Models used without a CLI estimate that no price covers. */
  unpricedModels: string[];
}
