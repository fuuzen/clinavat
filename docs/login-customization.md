# 登录页自定义

管理员进入「管理面板 → 站点个性化」，修改品牌、配色和登录页设计后点击「保存并应用」。站点访问地址在「管理面板 → 网关和访问 → 访问配置 → Public URL」单独管理并保存。

品牌名称和 Logo 同时应用到登录页、侧栏和管理面板，浏览器标题及图标同步更新。默认配色用于登录页和尚未设置个人外观的成员；已选择的个人配色继续保留。配置保存在现有 SQLite 数据库的 `site_settings` 表，服务重启后保留。在线成员通过事件更新，其他标签页会同步获取最新配置，重新访问也会读取服务端配置。

## 编辑默认布局

选择「左右分栏」或「居中表单」，设置介绍区域、品牌及功能示意卡片的显示状态，编辑欢迎标语、介绍和页脚。正文格式可选择 Markdown（支持内嵌 HTML）或 HTML。

「登录页全部文案」中可编辑登录、注册、首次初始化的标题、说明、按钮，以及字段标签、输入提示、切换入口、凭据说明、请求错误和表单校验提示。非必填展示文案可以清空。用户名和密码输入提示使用纯文本，展示内容支持所选正文格式。

错误文案中的 `{{error}}` 代表服务端错误消息。可保留该变量，也可使用完全自定义的固定提示；错误消息始终以纯文本展示。

## 重写整页

选择「整页自定义」，可直接填入 HTML 或 Markdown 示例，再修改内容与 CSS。模板必须恰好包含一个 `{{authForm}}`。该位置会渲染原有登录表单，保留真实认证、注册和初始化行为。不要自行编写账号密码输入框或提交逻辑。

支持以下模板变量：

| 变量 | 内容 |
| --- | --- |
| `{{siteName}}` | 站点名称 |
| `{{logoUrl}}` | 自定义 Logo，未设置时为默认 Logo |
| `{{welcome}}` | 欢迎标语 |
| `{{description}}` | 站点说明 |
| `{{authForm}}` | 整页模板中的登录表单插槽 |

变量替换会转义 HTML 特殊字符。建议将表单占位符放在单独的块级容器中，不要放进 HTML 属性、注释或 Markdown 代码块。

```html
<main class="landing">
  <section>
    <img src="{{logoUrl}}" alt="" width="64" height="64">
    <h1>{{siteName}}</h1>
    <p>把你的介绍、公告、帮助链接放在这里。</p>
  </section>
  <section class="sign-in">{{authForm}}</section>
</main>
```

将样式写入「登录页 CSS」字段，直接填写规则，不需要 `<style>` 标签：

```css
.landing {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: 48px;
  padding: 48px 8%;
  background: var(--bg);
  color: var(--text);
}
.sign-in {
  padding: 32px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--panel);
}
@media (max-width: 700px) {
  .landing { grid-template-columns: 1fr; padding: 24px; }
}
```

可使用主题变量 `--bg`、`--panel`、`--text`、`--muted`、`--accent`、`--line` 等。表单容器为 `.auth-form-wrap`，提交按钮为 `.auth-submit`，输入框可用 `[name="username"]` 和 `[name="password"]` 定位。

## 预览与备份

右侧预览与实际登录页共用渲染组件，可切换桌面、手机、登录、注册和初始化状态，也可放大查看。预览地址栏使用当前浏览器的 Origin，不读取或修改「网关和访问」中的公开访问名单。预览提交不会发起登录请求或创建账号。撤销修改、恢复默认设计和导入 JSON 仅更新编辑内容，点击「保存并应用」后才影响全站。

JSON 备份包含公开设计和图片，不包含用户凭据或站点访问地址。Logo 与浏览器图标分别支持不超过 2 MiB 的 PNG、JPEG、WebP 图片；设计 JSON 导入上限为 6 MiB。

## 内容和资源约束

HTML 支持常用排版、图片、链接、表格和内联样式。脚本、事件处理器、嵌套框架及额外表单控件会被过滤。自定义页面在隔离框架内渲染，CSS 不会修改管理面板和工作台。

现有部署的内容安全策略保持生效：图片使用上传生成的 data URL 或站内资源路径（例如 `/images/team.png`，需提前部署该文件），不加载任意外部图片；样式直接填写 CSS，外部样式表和字体不在支持范围。普通帮助链接可以指向外部网站，并在新窗口打开。

单项文案和欢迎标语最多 4000 字符；说明、补充内容、页脚和 CSS 各最多 65536 字符，整页模板最多 131072 字符。后端及代理仅为站点设置保存接口提供 6 MiB 请求上限。

设计参考了开源 [Casdoor 的登录页 UI 定制](https://casdoor.ai/docs/application/ui-customization/)：将页面内容、CSS、表单位置和预览分别配置，同时保留原有认证流程。
