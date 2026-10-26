import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plug, RotateCcw, TerminalSquare } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

export default function TerminalView({ projectId }: { projectId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [requested, setRequested] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!requested || !containerRef.current) return;
    let disposed = false;
    setError("");
    setConnecting(true);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#111512",
        foreground: "#c8d0c9",
        cursor: "#b6e8b0",
        selectionBackground: "#3b5140",
        black: "#111512",
        red: "#ee928a",
        green: "#b6e8b0",
        yellow: "#e7cc8d",
        blue: "#94bced",
        magenta: "#c3a3e0",
        cyan: "#8bcfc9",
        white: "#e1e5e0",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    const url = new URL(
      `/api/projects/${projectId}/terminal`,
      window.location.href,
    );
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const sendSize = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
    };
    socket.onopen = () => {
      if (disposed) return;
      sendSize();
      terminal.focus();
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          message?: string;
          code?: number;
        };
        if (message.type === "ready") {
          setConnected(true);
          setConnecting(false);
          sendSize();
        }
        if (message.type === "output") terminal.write(message.data || "");
        if (message.type === "error") {
          setError(message.message || "终端连接失败");
          terminal.writeln(`\r\n${message.message || "终端连接失败"}`);
        }
        if (message.type === "exit")
          terminal.writeln(
            `\r\n[远程进程已退出，状态码 ${message.code ?? "未知"}]`,
          );
      } catch {
        terminal.write(String(event.data));
      }
    };
    socket.onerror = () => {
      if (!disposed) setError("无法连接远程终端，请检查开发机连接。");
    };
    socket.onclose = () => {
      if (!disposed) {
        setConnected(false);
        setConnecting(false);
        terminal.writeln("\r\n[连接已关闭]");
      }
    };
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "input", data }));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resize.observe(containerRef.current);
    return () => {
      disposed = true;
      resize.disconnect();
      input.dispose();
      socket.close();
      terminal.dispose();
      setConnected(false);
    };
  }, [projectId, requested, attempt]);
  return (
    <div className="terminal-view">
      {!requested ? (
        <div className="inspector-empty">
          <TerminalSquare size={29} />
          <strong>就在你的开发机上</strong>
          <p>
            打开真实 SSH 终端，
            <br />
            在远程项目目录中运行命令。
          </p>
          <button
            className="button button-secondary"
            onClick={() => setRequested(true)}
          >
            <Plug size={14} />
            连接终端
          </button>
        </div>
      ) : (
        <>
          <div className="terminal-toolbar">
            <span>
              <span className={`status-dot ${connected ? "online" : ""}`} />
              {connected
                ? "SSH 已连接"
                : connecting
                  ? "正在连接 SSH…"
                  : "连接已断开"}
            </span>
            <button
              className="icon-button"
              onClick={() => setAttempt((value) => value + 1)}
              title="重新连接"
              aria-label="重新连接终端"
            >
              <RotateCcw size={14} />
            </button>
          </div>
          {error && <div className="terminal-error">{error}</div>}
          <div className="terminal-container" ref={containerRef} />
        </>
      )}
    </div>
  );
}
