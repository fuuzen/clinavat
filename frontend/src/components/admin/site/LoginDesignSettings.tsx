import { Code2, LayoutTemplate } from "lucide-react";
import type { SiteSettings } from "../../../site/settings";

const htmlExample = `<main class="custom-landing">
  <section class="custom-intro">
    <img src="{{logoUrl}}" alt="" width="64" height="64" />
    <h1>{{siteName}}</h1>
    <p>让想法成为现实。</p>
    <a href="https://example.com/docs">使用指南 →</a>
  </section>
  <section class="custom-form">{{authForm}}</section>
</main>`;
const markdownExample = `# {{siteName}}

欢迎来到你的工作台。自由编写介绍、公告与帮助链接。

- 连接自己的开发环境
- 与团队一起创造

[使用指南](https://example.com/docs)

{{authForm}}
`;
const exampleCss = `.custom-landing { min-height: 100dvh; display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 48px; padding: 60px 8%; background: radial-gradient(circle at top left, var(--accent-dim), var(--bg) 70%); }
.custom-intro h1 { font-size: clamp(32px, 5vw, 64px); }
.custom-intro p { margin: 24px 0; color: var(--muted); }
.custom-form { display: flex; justify-content: center; padding: 36px; border: 1px solid var(--line); border-radius: 20px; background: var(--panel); }
@media (max-width: 700px) { .custom-landing { grid-template-columns: 1fr; padding: 30px 20px; gap: 28px; } .custom-form { padding: 24px; } }`;

export default function LoginDesignSettings({ value, onChange }: { value: SiteSettings; onChange: (next: SiteSettings) => void }) {
  const login = value.login;
  function update<K extends keyof SiteSettings["login"]>(key: K, next: SiteSettings["login"][K]) {
    onChange({ ...value, login: { ...login, [key]: next } });
  }
  function applyExample(format: "markdown" | "html") {
    onChange({ ...value, login: { ...login, layout: "custom", contentFormat: format, pageContent: format === "html" ? htmlExample : markdownExample, customCss: format === "html" ? exampleCss : ".auth-custom-page { max-width: 820px; margin: auto; padding: 48px 24px; }\n.auth-custom-page .auth-form-wrap { margin: 40px auto; }" } });
  }
  return <>
    <section className="admin-card admin-site-section">
      <div className="admin-card-heading"><h3>登录页布局</h3><LayoutTemplate size={19} /></div>
      <p className="admin-site-description">可逐项编辑默认页面，也可重写整页布局。登录、注册和首次初始化共用这份设计。</p>
      <label>页面布局<select aria-label="页面布局" value={login.layout} onChange={(event) => update("layout", event.target.value as typeof login.layout)}>
        <option value="split">左右分栏</option><option value="centered">居中表单</option><option value="custom">整页自定义</option>
      </select></label>
      <label>内容格式<select aria-label="内容格式" value={login.contentFormat} onChange={(event) => update("contentFormat", event.target.value as typeof login.contentFormat)}><option value="markdown">Markdown（也支持内嵌 HTML）</option><option value="html">HTML</option></select></label>
      {login.layout !== "custom" && <div className="admin-site-toggles">
        {([['showBrand', '显示品牌标识'], ['showStory', '显示介绍区域'], ['showPreview', '显示功能示意卡片']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={login[key]} onChange={(event) => update(key, event.target.checked)} />{label}</label>)}
      </div>}
      <p className="admin-site-hint">正文支持标题、链接、图片、列表和 HTML 布局。图片使用站内路径或图片 data URL。样式写入下方 CSS；脚本和额外登录表单会被移除。</p>
      {login.layout !== "custom" && <>
        <label>介绍区补充内容<textarea aria-label="介绍区补充内容" className="admin-site-code" rows={7} maxLength={65536} value={login.storyContent} onChange={(event) => update("storyContent", event.target.value)} placeholder="补充展示图文、公告等；留空不显示额外内容" /></label>
        <label>页脚内容<textarea aria-label="页脚内容" className="admin-site-code" rows={3} maxLength={65536} value={login.footerContent} onChange={(event) => update("footerContent", event.target.value)} /></label>
      </>}
      {login.layout === "custom" && <>
        <div className="admin-site-template-actions"><span>示例会替换整页内容和 CSS</span><button type="button" className="button button-secondary button-small" onClick={() => applyExample("html")}>填入 HTML 示例</button><button type="button" className="button button-secondary button-small" onClick={() => applyExample("markdown")}>填入 Markdown 示例</button></div>
        <label>整页内容<textarea aria-label="整页内容" className="admin-site-code" rows={15} maxLength={131072} value={login.pageContent} onChange={(event) => update("pageContent", event.target.value)} spellCheck={false} /></label>
        <p className="admin-site-hint">在页面中恰好放置一个 <code>{"{{authForm}}"}</code>，显示可正常登录的表单。支持 <code>{"{{siteName}}"}</code>、<code>{"{{logoUrl}}"}</code>、<code>{"{{welcome}}"}</code>、<code>{"{{description}}"}</code> 变量。</p>
      </>}
    </section>
    <section className="admin-card admin-site-section">
      <div className="admin-card-heading"><h3>登录页 CSS</h3><Code2 size={19} /></div>
      <p className="admin-site-description">只影响登录页和右侧预览。可使用主题变量 <code>--bg</code>、<code>--text</code>、<code>--accent</code>。表单容器为 <code>.auth-form-wrap</code>，按钮为 <code>.auth-submit</code>。直接填写 CSS 规则；外部样式与字体受站点策略限制。</p>
      <label>自定义 CSS<textarea aria-label="自定义 CSS" className="admin-site-code" rows={9} value={login.customCss} maxLength={65536} onChange={(event) => update("customCss", event.target.value)} placeholder=".auth-form-wrap { max-width: 420px; }" spellCheck={false} /></label>
    </section>
  </>;
}
