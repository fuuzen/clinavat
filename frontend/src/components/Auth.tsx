import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  CircleDot,
  LoaderCircle,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { errorText, post } from "../api";

interface Props {
  needsSetup: boolean;
  registrationEnabled: boolean;
  onAuthenticated: () => Promise<void>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark">
        <Braces size={22} strokeWidth={1.8} />
      </span>
      <span>
        cc<span className="brand-light">pool</span>
        <i />
      </span>
    </div>
  );
}

export default function Auth({
  needsSetup,
  registrationEnabled,
  onAuthenticated,
}: Props) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(
        `/auth/${needsSetup ? "setup" : register ? "register" : "login"}`,
        { username, password },
      );
      await onAuthenticated();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-story">
        <Brand />
        <div className="auth-story-body">
          <div className="eyebrow">
            <span className="live-dot" /> YOUR ENVIRONMENT. YOUR AGENT.
          </div>
          <h1>
            代码在你手中，
            <br />
            <span>可能性在此展开。</span>
          </h1>
          <p>
            一个工作台，连接原生编程智能体与自己的开发环境。
            <br />
            从想法到交付，让协作自然发生。
          </p>
          <div className="auth-preview">
            <div className="preview-bar">
              <span />
              <span />
              <span />
              <small>workspace / your-next-idea</small>
            </div>
            <div className="preview-line">
              <TerminalSquare size={16} />
              <span>连接开发环境</span>
              <Check size={14} />
            </div>
            <div className="preview-line">
              <CircleDot size={16} />
              <span>独立账号，专属空间</span>
              <Check size={14} />
            </div>
            <div className="preview-code">
              <span>❯</span> 今天，一起创造些什么？
              <i />
            </div>
          </div>
        </div>
        <div className="auth-footnote">
          <ShieldCheck size={14} /> 独立账号槽位 · 远程执行 · 由你掌控
        </div>
      </div>
      <div className="auth-form-panel">
        <div className="auth-form-wrap">
          <span className="subtle-label">WELCOME TO CC-POOL</span>
          <h2>
            {needsSetup ? "建立你的工作台" : register ? "创建账号" : "欢迎回来"}
          </h2>
          <p>
            {needsSetup
              ? "创建首个管理员账号，开始配置你的号池。"
              : register
                ? "加入工作台，连接你的开发环境。"
                : "登录账号，接着上一次的灵感继续。"}
          </p>
          <form onSubmit={submit}>
            <label>
              用户名
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="你的用户名"
                minLength={3}
                maxLength={40}
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete={
                  needsSetup || register ? "new-password" : "current-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={
                  needsSetup || register ? "至少 12 位字符" : "输入密码"
                }
                minLength={needsSetup || register ? 12 : 1}
                required
              />
            </label>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary auth-submit"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <>
                  {needsSetup
                    ? "创建工作台"
                    : register
                      ? "创建账号"
                      : "进入工作台"}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          {!needsSetup && registrationEnabled && (
            <div className="auth-switch">
              {register ? "已有账号？" : "还没有账号？"}
              <button
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register ? "登录" : "创建账号"}
              </button>
            </div>
          )}
          <div className="auth-note">
            <ShieldCheck size={15} />
            <span>凭据仅保存在你的 CC-Pool 服务中。</span>
          </div>
        </div>
      </div>
    </main>
  );
}
