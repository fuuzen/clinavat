import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plug, RotateCcw, TerminalSquare } from "lucide-react";
import { getThemePalette, useTheme, type ThemePreferences } from "../theme";
import "@xterm/xterm/css/xterm.css";

function terminalTheme(preferences: ThemePreferences) {
  const palette = getThemePalette(preferences);
  return {
    background: palette["--bg"],
    foreground: palette["--text"],
    cursor: palette["--accent"],
    cursorAccent: palette["--on-accent"],
    selectionBackground: palette["--accent-dim"],
    black: palette["--muted"],
    red: palette["--danger"],
    green: palette["--success"],
    yellow: palette["--warning"],
    blue: palette["--info"],
    magenta: palette["--terminal-magenta"],
    cyan: palette["--terminal-cyan"],
    white: palette["--text-secondary"],
    brightBlack: palette["--muted"],
    brightRed: palette["--danger"],
    brightGreen: palette["--success"],
    brightYellow: palette["--warning"],
    brightBlue: palette["--info"],
    brightMagenta: palette["--terminal-magenta"],
    brightCyan: palette["--terminal-cyan"],
    brightWhite: palette["--text"],
  };
}

export default function TerminalView({ projectId }: { projectId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const { preferences } = useTheme();
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [connected, setConnected] = useState(false);
  const [requested, setRequested] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = terminalTheme(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!requested || !containerRef.current) return;
    let disposed = false;
    setError("");
    setConnecting(true);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: terminalTheme(preferencesRef.current),
      scrollback: 5000,
    });
    terminalRef.current = terminal;
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
      terminalRef.current = null;
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
