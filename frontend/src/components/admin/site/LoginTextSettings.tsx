import { CaseSensitive } from "lucide-react";
import type { LoginTexts, SiteSettings } from "../../../site/settings";

const groups: { title: string; fields: [keyof LoginTexts, string][] }[] = [
  { title: "介绍区与页面标题", fields: [["eyebrow", "介绍区眉题"], ["previewTitle", "功能卡片标题"], ["previewEnvironment", "功能卡片第一行"], ["previewAccount", "功能卡片第二行"], ["previewPrompt", "功能卡片提示语"], ["formEyebrow", "表单眉题"], ["securityNote", "凭据说明"], ["frameTitle", "登录页面无障碍标题"]] },
  { title: "登录", fields: [["loginTitle", "登录标题"], ["loginDescription", "登录说明"], ["loginSubmit", "登录按钮"], ["registerPrompt", "注册引导语"], ["registerLink", "切换注册按钮"]] },
  { title: "注册", fields: [["registerTitle", "注册标题"], ["registerDescription", "注册说明"], ["registerSubmit", "注册按钮"], ["loginPrompt", "登录引导语"], ["loginLink", "切换登录按钮"]] },
  { title: "首次初始化", fields: [["setupTitle", "初始化标题"], ["setupDescription", "初始化说明"], ["setupSubmit", "初始化按钮"]] },
  { title: "输入框与提交状态", fields: [["usernameLabel", "用户名标签"], ["usernamePlaceholder", "用户名占位文字"], ["passwordLabel", "密码标签"], ["passwordPlaceholder", "登录密码占位文字"], ["newPasswordPlaceholder", "新密码占位文字"], ["busySubmit", "正在提交的按钮文字"]] },
  { title: "错误与校验提示", fields: [["loginError", "登录失败提示"], ["registerError", "注册失败提示"], ["setupError", "初始化失败提示"], ["requiredValidation", "必填提示"], ["usernameValidation", "用户名格式提示"], ["passwordValidation", "密码长度提示"]] },
];

export default function LoginTextSettings({ value, onChange }: { value: SiteSettings; onChange: (next: SiteSettings) => void }) {
  return <section className="admin-card admin-site-section">
    <div className="admin-card-heading"><h3>全部页面文案</h3><CaseSensitive size={19} /></div>
    <p className="admin-site-description">各项都可修改或清空。标题、说明、标签和按钮支持 Markdown / HTML；输入占位、校验、错误提示与无障碍标题使用纯文本。可用 <code>{"{{siteName}}"}</code> 插入站点名称，错误提示可用 <code>{"{{error}}"}</code> 插入服务返回的原因。</p>
    {groups.map((group) => <details className="admin-site-text-group" key={group.title}>
      <summary>{group.title}<span>{group.fields.length} 项</span></summary>
      <div className="admin-site-text-grid">{group.fields.map(([key, label]) => <label key={key}>{label}<textarea aria-label={label} rows={2} maxLength={4000} value={value.login.texts[key]} onChange={(event) => onChange({ ...value, login: { ...value.login, texts: { ...value.login.texts, [key]: event.target.value } } })} /></label>)}</div>
    </details>)}
  </section>;
}
