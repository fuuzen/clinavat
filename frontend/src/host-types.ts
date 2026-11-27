export type ClientPlatform = "windows" | "macos" | "linux";

export interface ClientDevice {
  id: string;
  platform: ClientPlatform;
  arch: string;
  os_version: string;
  default_shell: string;
  homedir: string;
  last_seen_at: string | null;
  online?: boolean;
}

export interface DevHost {
  id: string;
  kind?: "local" | "ssh" | "client";
  name: string;
  host: string;
  port: number;
  username: string;
  status: string;
  fingerprint?: string;
  jump_host?: string | null;
  jump_port?: number | null;
  jump_username?: string | null;
  device?: ClientDevice | null;
}

export type ClientProjectMode = "direct" | "mirrored";

export interface Project {
  id: string;
  name: string;
  dev_host_id: string;
  remote_path: string;
  local_path: string;
  path_mode: "auto" | "direct" | "bwrap" | "symlink";
  execution_mode: "local" | "direct" | "bwrap" | "symlink" | "client" | null;
  sync_status: string;
  client_mode?: ClientProjectMode;
  vm_path?: string | null;
  /** JSON of SkippedLinks, the symbolic links the sync last reported as skipped; null when there are none. */
  sync_skipped_links?: string | null;
  /** Set on a child agent's Git worktree: the master project it belongs to. It is listed with that project. */
  parent_project_id?: string | null;
  worktree_branch?: string | null;
  /** Run once in each new worktree of a child agent, such as installing dependencies. */
  worktree_setup?: string | null;
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
