export interface CompletionToken {
  kind: 'command' | 'path';
  query: string;
  start: number;
  end: number;
}

export function completionToken(text: string, cursor: number): CompletionToken | null {
  const before = text.slice(0, cursor);
  const command = /^\s*\/([^\s]*)$/.exec(before);
  if (command) {
    const suffix = /^[^\s]*/.exec(text.slice(cursor))![0];
    return { kind: 'command', query: command[1], start: before.indexOf('/'), end: cursor + suffix.length };
  }
  const reference = /(?:^|\s)@(?:"((?:[^"\\\n]|\\.)*)|([^\s"'<>`]*))$/.exec(before);
  if (!reference) return null;
  const quoted = reference[1] !== undefined;
  const suffix = quoted ? /^(?:[^"\\\n]|\\.)*"?/.exec(text.slice(cursor))![0]
    : /^[^\s"'<>`]*/.exec(text.slice(cursor))![0];
  return {
    kind: 'path',
    query: (reference[1] ?? reference[2]).replace(/\\(["\\])/g, '$1'),
    start: reference.index + reference[0].indexOf('@'),
    end: cursor + suffix.length,
  };
}

export function referenceCompletion(path: string, directory: boolean): string {
  const value = path + (directory ? '/' : '');
  if (/[\s"']/.test(value)) return `@"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"${directory ? '' : ' '}`;
  return `@${value}${directory ? '' : ' '}`;
}
