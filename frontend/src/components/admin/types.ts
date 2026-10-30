export type AdminTab =
  | "overview"
  | "site"
  | "host"
  | "workspaces"
  | "connections"
  | "users"
  | "slots"
  | "gateway";

export interface AdminHealth {
  status: string;
  version: string;
  runtime: {
    claude: boolean;
    codex: boolean;
    mutagen: boolean;
    ssh: boolean;
  };
}
