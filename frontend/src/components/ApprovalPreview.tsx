import { FileCode2, Terminal } from "lucide-react";

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return parseInput(JSON.parse(input));
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export default function ApprovalPreview({
  tool,
  input,
}: {
  tool: string;
  input: unknown;
}) {
  const values = parseInput(input);
  const path =
    typeof values.file_path === "string"
      ? values.file_path
      : typeof values.path === "string"
        ? values.path
        : "";
  const before =
    typeof values.old_string === "string"
      ? values.old_string
      : typeof values.oldText === "string"
        ? values.oldText
        : typeof values.previousContent === "string"
          ? values.previousContent
          : undefined;
  const after =
    typeof values.new_string === "string"
      ? values.new_string
      : typeof values.newText === "string"
        ? values.newText
        : typeof values.content === "string"
          ? values.content
          : undefined;
  const isWrite =
    typeof values.content === "string" &&
    ![values.new_string, values.newText].some(
      (value) => typeof value === "string",
    );
  const removed = before ? before.split("\n") : [];
  const added = after ? after.split("\n") : [];
  const changes = [
    ...removed.map((text) => ({ text, kind: "diff-deletion", prefix: "−" })),
    ...added.map((text) => ({ text, kind: "diff-addition", prefix: "+" })),
  ];
  const command = typeof values.command === "string" ? values.command : null;
  const showCommand =
    command !== null && /bash|remote_command|shell/i.test(tool);
  const showDiff = after !== undefined && (path || before !== undefined);
  return (
    <div className="approval-preview">
      {showDiff && (
        <div className="approval-file-diff">
          <div className="approval-file-heading">
            <FileCode2 size={13} />
            <span title={path}>{path || "文件变更"}</span>
            <small>{isWrite ? "完整写入" : "替换片段"}</small>
          </div>
          <div className="diff-preview">
            {changes.slice(0, 400).map((line, index) => (
              <div key={index} className={line.kind}>
                {line.prefix} {line.text}
              </div>
            ))}
          </div>
          {changes.length > 400 && (
            <p className="approval-truncated">
              已预览前 400 行，展开原始请求查看完整内容。
            </p>
          )}
        </div>
      )}
      {showCommand && (
        <div className="approval-command">
          <div>
            <Terminal size={13} />
            <span>远程命令</span>
            <small>
              {typeof values.cwd === "string" ? values.cwd : "当前项目目录"}
            </small>
          </div>
          <pre>$ {command}</pre>
        </div>
      )}
      <details className="approval-raw" open={!showDiff && !showCommand}>
        <summary>查看原始请求</summary>
        <pre>
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      </details>
    </div>
  );
}
