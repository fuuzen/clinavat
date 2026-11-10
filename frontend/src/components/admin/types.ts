export type AdminTab =
  | "overview"
  | "site"
  | "host"
  | "workspaces"
  | "connections"
  | "users"
  | "slots"
  | "gateway"
  | "questions";

export interface AdminHealth {
  status: string;
  version: string;
  execution: "process" | "vm";
  runtime: {
    claude: boolean;
    codex: boolean;
    mutagen: boolean;
    ssh: boolean;
  };
}
