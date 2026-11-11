// Mirrors the backend's reference parsing, which ignores @ inside code.
/** Blanks out fenced code blocks and code spans, keeping offsets. */
export function blankMarkdownCode(text: string): string {
  let fence: { marker: string; size: number } | null = null;
  const blank = (value: string) => value.replace(/[^\n]/g, ' ');
  return text.split('\n').map(line => {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.size) fence = null;
      return blank(line);
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string cannot contain backticks; such a line is an inline code span instead.
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) return line;
    // An unclosed fence runs to the end of the message.
    fence = { marker: open[1][0], size: open[1].length };
    return blank(line);
  }).join('\n').replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, blank);
}
