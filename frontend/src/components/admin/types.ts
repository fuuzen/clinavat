export type AdminTab =
  | "overview"
  | "site"
  | "host"
  | "workspaces"
  | "connections"
  | "users"
  | "slots"
  | "gateway"
  | "questions"
  | "usage";

export interface AdminHealth {
  status: string;
  version: string;
  execution: "process" | "vm";
  runtime: {
    claude: boolean;
    codex: boolean;
    agy: boolean;
    mutagen: boolean;
    ssh: boolean;
  };
}

export type DevHostApprovalStatus = "pending" | "approved" | "rejected" | "revoked";

export interface DevHostApprovalView {
  id: string;
  user_id: string;
  username: string | null;
  dev_host_id: string | null;
  dev_host_name: string | null;
  hop: "target" | "jump";
  hostname: string;
  pinned_ip: string;
  port: number;
  status: DevHostApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_by_username: string | null;
  note: string | null;
}

export interface DevHostRelayStatus {
  enabled: boolean;
  port: number;
  activeConnections: number;
}

export interface DevHostApprovalsResponse {
  approvals: DevHostApprovalView[];
  relay: DevHostRelayStatus;
}
