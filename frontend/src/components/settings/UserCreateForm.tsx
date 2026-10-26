import { useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle, UserPlus } from "lucide-react";
import { errorText } from "../../api";

interface Props {
  onCreate: (username: string, password: string) => Promise<void>;
  onCancel: () => void;
}

export default function UserCreateForm({ onCreate, onCancel }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const normalizedUsername = username.trim();
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(normalizedUsername)) {
      setError(
        "用户名需为 3–40 个字符，仅支持字母、数字、下划线、点和连字符。",
      );
      return;
    }
    if (password.length < 12 || password.length > 256) {
      setError("初始密码需为 12–256 个字符。");
      return;
    }
    setSaving(true);
    try {
      await onCreate(normalizedUsername, password);
      setPassword("");
      setUsername("");
      setShowPassword(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="user-create-form" onSubmit={submit}>
      <div className="settings-section-heading">
        <UserPlus size={16} />
        <h3>创建普通成员</h3>
        <span className="badge">成员权限</span>
      </div>
      <label>
        用户名
        <input
          autoFocus
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="输入成员用户名"
          minLength={3}
          maxLength={40}
          required
          disabled={saving}
        />
      </label>
      <p className="user-field-hint">
        3–40 个字符，支持中文等字母、数字、下划线、点和连字符。
      </p>
      <label htmlFor="new-member-password">初始密码</label>
      <div className="user-password-input">
        <input
          id="new-member-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="12–256 个字符"
          minLength={12}
          maxLength={256}
          required
          disabled={saving}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={showPassword ? "隐藏初始密码" : "显示初始密码"}
          aria-pressed={showPassword}
          onClick={() => setShowPassword(!showPassword)}
          disabled={saving}
        >
          {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <p className="user-field-hint">
        成员使用此密码登录。创建后请通过你信任的方式交给本人。
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="user-create-actions">
        <button
          type="button"
          className="button button-ghost button-small"
          disabled={saving}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="button button-primary button-small"
          disabled={saving}
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <UserPlus size={14} />
          )}
          {saving ? "正在创建…" : "创建成员"}
        </button>
      </div>
    </form>
  );
}
