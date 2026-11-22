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
