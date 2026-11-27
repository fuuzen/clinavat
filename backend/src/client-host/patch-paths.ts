const GIT_ESCAPES: Record<string, number> = {
  '\\': 0x5c, '"': 0x22, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
};
const OCTAL_BYTE_RE = /^[0-3][0-7]{2}/;
const STRICT_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Decodes a Git C-style quoted path token starting at `start` (`"..."`) using strict 3-digit octal & UTF-8 rules. */
function parseGitQuotedPath(raw: string, start: number): { value: string; nextIndex: number } {
  const bytes: number[] = [];
  for (let i = start + 1; i < raw.length; ) {
    const ch = raw[i]!;
    if (ch === '"') {
      let value: string;
      try {
        value = utf8Strict.decode(Uint8Array.from(bytes));
      } catch {
        throw new Error('补丁引号路径包含非法 UTF-8 字节序列');
      }
      if (value.includes('\0')) throw new Error('补丁路径包含非法空字节');
      return { value, nextIndex: i + 1 };
    }
    if (ch === '\\') {
      i++;
      if (i >= raw.length) throw new Error('补丁引号路径存在未闭合转义');
      const esc = raw[i]!;
      if (esc >= '0' && esc <= '7') {
        const oct = OCTAL_BYTE_RE.exec(raw.slice(i, i + 3))?.[0];
        if (!oct) throw new Error(`补丁引号路径包含非法八进制转义：\\${raw.slice(i, i + 3)}`);
        const code = parseInt(oct, 8);
        if (code === 0) throw new Error('补丁引号路径包含非法空字节转义：\\000');
        bytes.push(code);
        i += 3;
        continue;
      }
      const mapped = GIT_ESCAPES[esc];
      if (mapped === undefined) throw new Error(`补丁引号路径包含不支持的转义序列：\\${esc}`);
      bytes.push(mapped);
      i++;
      continue;
    }
    const cp = raw.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    for (const byte of Buffer.from(raw.slice(i, i + step), 'utf8')) bytes.push(byte);
    i += step;
  }
  throw new Error('补丁引号路径缺少闭合引号');
}

function stripDiffAb(value: string, stripAb: boolean): string | null {
  if (!value || value === '/dev/null') return null;
  return stripAb && (value.startsWith('a/') || value.startsWith('b/')) ? value.slice(2) : value;
}

function parseSinglePatchPath(raw: string, stripAb: boolean, allowTimestampTab: boolean): string | null {
  if (!allowTimestampTab && raw.includes('\t')) {
    throw new Error('补丁路径不能包含制表符');
  }
  const trimmed = raw.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const { value, nextIndex } = parseGitQuotedPath(trimmed, 0);
    const tail = trimmed.slice(nextIndex);
    const tailOk = allowTimestampTab ? /^(?:\t.*|\s+)$/.test(tail) : /^\s+$/.test(tail);
    if (tail.length > 0 && !tailOk) throw new Error('补丁引号路径后包含非法尾随字符');
    if (!allowTimestampTab && value.includes('\t')) throw new Error('补丁路径不能包含制表符');
    return stripDiffAb(value, stripAb);
  }
  const value = allowTimestampTab ? (trimmed.split('\t')[0] ?? '').trim() : trimmed.trim();
  return stripDiffAb(value, stripAb);
}

/** Fail-closed parser for `diff --git <lhs> <rhs>` supporting quoted paths, spaces, renames, and `--no-prefix`. */
function parseGitDiffHeader(line: string): string[] {
  const rest = line.replace(/^diff --git[ \t]+/, '');
  if (!rest) throw new Error('diff --git 头部缺少文件路径');
  const extracted = new Set<string>();
  const addPair = (left: string, right: string) => {
    const l = stripDiffAb(left, true);
    const r = stripDiffAb(right, true);
    if (!l || !r) throw new Error('diff --git 头部包含空路径');
    extracted.add(l);
    extracted.add(r);
  };
  if (rest.startsWith('"')) {
    const left = parseGitQuotedPath(rest, 0);
    if (rest[left.nextIndex] !== ' ') throw new Error('diff --git 头部路径分隔无效');
    const rightRaw = rest.slice(left.nextIndex + 1);
    if (!rightRaw) throw new Error('diff --git 头部缺少目标路径');
    if (rightRaw.startsWith('"')) {
      const right = parseGitQuotedPath(rightRaw, 0);
      if (right.nextIndex !== rightRaw.length) throw new Error('diff --git 头部存在非法尾随内容');
      addPair(left.value, right.value);
    } else {
      addPair(left.value, rightRaw);
    }
    return [...extracted];
  }
  if (rest.endsWith('"')) {
    for (let idx = rest.indexOf(' "'); idx !== -1; idx = rest.indexOf(' "', idx + 1)) {
      try {
        const right = parseGitQuotedPath(rest, idx + 1);
        if (right.nextIndex === rest.length && idx > 0) addPair(rest.slice(0, idx), right.value);
      } catch { /* Try next candidate boundary. */ }
    }
    if (!extracted.size) throw new Error('无法解析 diff --git 头部路径');
    return [...extracted];
  }
  const abCandidates: Array<{ lhs: string; rhs: string }> = [];
  for (let i = 1; i < rest.length - 1; i++) {
    if (rest[i] !== ' ') continue;
    const lhs = rest.slice(0, i);
    const rhs = rest.slice(i + 1);
    if (lhs.startsWith('a/') && rhs.startsWith('b/')) abCandidates.push({ lhs, rhs });
  }
  if (abCandidates.length) {
    const exact = abCandidates.filter(c => c.lhs.slice(2) === c.rhs.slice(2));
    const chosen = exact.length === 1 ? exact : abCandidates;
    for (const c of chosen) addPair(c.lhs, c.rhs);
    return [...extracted];
  }
  if (rest.length >= 3 && rest.length % 2 === 1) {
    const mid = (rest.length - 1) / 2;
    if (rest[mid] === ' ') {
      const lhs = rest.slice(0, mid);
      const rhs = rest.slice(mid + 1);
      if (lhs && lhs === rhs) return [lhs];
    }
  }
  throw new Error('无法解析 diff --git 头部路径');
}

/** Extracts all file paths referenced in unified diff or apply_patch headers with strict fail-closed validation. */
export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  let sawApplyPatch = false;
  let sawUnifiedDiff = false;
  let oldRem = 0;
  let newRem = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (oldRem > 0 || newRem > 0) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith(' ') || line === '') {
        if (oldRem <= 0 || newRem <= 0) throw new Error('补丁 hunk 上下文行超出声明计数');
        oldRem--;
        newRem--;
        continue;
      }
      if (line.startsWith('-')) {
        if (oldRem <= 0) throw new Error('补丁 hunk 删除行超出声明计数');
        oldRem--;
        continue;
      }
      if (line.startsWith('+')) {
        if (newRem <= 0) throw new Error('补丁 hunk 新增行超出声明计数');
        newRem--;
        continue;
      }
      throw new Error('补丁 hunk 内容与声明行数不匹配');
    }

    if (line.startsWith('@@')) {
      const hunk = STRICT_HUNK_RE.exec(line);
      if (hunk) {
        sawUnifiedDiff = true;
        oldRem = hunk[2] !== undefined ? Number(hunk[2]) : 1;
        newRem = hunk[4] !== undefined ? Number(hunk[4]) : 1;
        continue;
      }
      if (!sawApplyPatch || sawUnifiedDiff) {
        throw new Error(`不支持或格式错误的 hunk 头：${line}`);
      }
      continue;
    }

    if (/^\s*\*\*\*\s+(?:Begin|End)\s+Patch\s*$/.test(line)) {
      sawApplyPatch = true;
      continue;
    }
    const applyMatch = /^\s*\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/.exec(line)
      ?? /^\s*\*\*\*\s+Move\s+to:\s*(.+)$/.exec(line);
    if (applyMatch) {
      sawApplyPatch = true;
      const p = parseSinglePatchPath(applyMatch[1]!, false, false);
      if (!p) throw new Error(`apply_patch 头部缺少有效路径：${line}`);
      paths.add(p);
      continue;
    }
    if (/^diff\s+--(?!(?:git(?:\s|$)))/.test(line)) {
      throw new Error(`不支持的补丁头格式：${line}`);
    }
    if (/^diff --git(?:\s|$)/.test(line)) {
      sawUnifiedDiff = true;
      for (const p of parseGitDiffHeader(line)) paths.add(p);
      continue;
    }
    const header = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (header) {
      sawUnifiedDiff = true;
      const p = parseSinglePatchPath(header[1]!, true, true);
      if (p) paths.add(p);
      continue;
    }
    if (/^(?:rename|copy)\b/.test(line)) {
      sawUnifiedDiff = true;
      const rename = /^(?:rename|copy)\s+(?:from|to|old|new)\s+(.+)$/.exec(line);
      if (!rename) throw new Error(`不支持的补丁扩展头：${line}`);
      const p = parseSinglePatchPath(rename[1]!, false, false);
      if (!p) throw new Error(`补丁扩展头缺少有效路径：${line}`);
      paths.add(p);
    }
  }

  if (oldRem > 0 || newRem > 0) {
    throw new Error('补丁 hunk 计数不完整或被截断');
  }
  if (sawApplyPatch && sawUnifiedDiff) {
    throw new Error('补丁不能混合 unified diff 与 apply_patch 格式');
  }
  if (!paths.size) {
    throw new Error('补丁未声明任何受影响的文件路径');
  }
  return [...paths];
}
