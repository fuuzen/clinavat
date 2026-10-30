export interface ComposerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export function parseSlashCommand(content: string): { name: string; arguments: string } | null {
  const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(content);
  return match ? { name: match[1].toLowerCase(), arguments: (match[2] ?? '').trim() } : null;
}
