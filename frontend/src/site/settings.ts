export interface LoginTexts {
  eyebrow: string;
  previewTitle: string;
  previewEnvironment: string;
  previewAccount: string;
  previewPrompt: string;
  formEyebrow: string;
  loginTitle: string;
  loginDescription: string;
  registerTitle: string;
  registerDescription: string;
  setupTitle: string;
  setupDescription: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  newPasswordPlaceholder: string;
  loginSubmit: string;
  registerSubmit: string;
  setupSubmit: string;
  busySubmit: string;
  registerPrompt: string;
  loginPrompt: string;
  registerLink: string;
  loginLink: string;
  securityNote: string;
  loginError: string;
  registerError: string;
  setupError: string;
  requiredValidation: string;
  usernameValidation: string;
  passwordValidation: string;
  frameTitle: string;
}

export interface SiteSettings {
  name: string;
  description: string;
  welcome: string;
  logo: string;
  favicon: string;
  theme: string;
  login: {
    layout: "split" | "centered" | "custom";
    contentFormat: "markdown" | "html";
    storyContent: string;
    footerContent: string;
    pageContent: string;
    customCss: string;
    showBrand: boolean;
    showStory: boolean;
    showPreview: boolean;
    texts: LoginTexts;
  };
}

export const defaultSiteSettings: SiteSettings = {
  name: "Clinavat",
  description: "一个工作台，连接原生编程智能体与自己的开发环境。\n\n从想法到交付，让协作自然发生。",
  welcome: "代码在你手中，\n可能性在此展开。",
  logo: "",
  favicon: "",
  theme: "forest",
  login: {
    layout: "split",
    contentFormat: "markdown",
    storyContent: "",
    footerContent: "独立账号槽位 · 远程执行 · 由你掌控",
    pageContent: "",
    customCss: "",
    showBrand: true,
    showStory: true,
    showPreview: true,
    texts: {
      eyebrow: "YOUR ENVIRONMENT. YOUR AGENT.",
      previewTitle: "workspace / your-next-idea",
      previewEnvironment: "连接开发环境",
      previewAccount: "独立账号，专属空间",
      previewPrompt: "今天，一起创造些什么？",
      formEyebrow: "WELCOME TO {{siteName}}",
      loginTitle: "欢迎回来",
      loginDescription: "登录账号，接着上一次的灵感继续。",
      registerTitle: "创建账号",
      registerDescription: "加入工作台，连接你的开发环境。",
      setupTitle: "建立你的工作台",
      setupDescription: "创建首个管理员账号，开始配置你的号池。",
      usernameLabel: "用户名",
      usernamePlaceholder: "你的用户名",
      passwordLabel: "密码",
      passwordPlaceholder: "输入密码",
      newPasswordPlaceholder: "至少 12 位字符",
      loginSubmit: "进入工作台",
      registerSubmit: "创建账号",
      setupSubmit: "创建工作台",
      busySubmit: "请稍候…",
      registerPrompt: "还没有账号？",
      loginPrompt: "已有账号？",
      registerLink: "创建账号",
      loginLink: "登录",
      securityNote: "凭据仅保存在你的 {{siteName}} 服务中。",
      loginError: "{{error}}",
      registerError: "{{error}}",
      setupError: "{{error}}",
      requiredValidation: "请填写此字段。",
      usernameValidation: "用户名需为 3–40 位字母、数字、下划线、点或短横线。",
      passwordValidation: "密码至少需要 12 位字符。",
      frameTitle: "{{siteName}} · 登录",
    },
  },
};

export function withSiteDefaults(value: Partial<SiteSettings>): SiteSettings {
  return {
    ...defaultSiteSettings,
    ...value,
    login: {
      ...defaultSiteSettings.login,
      ...value.login,
      texts: { ...defaultSiteSettings.login.texts, ...value.login?.texts },
    },
  };
}
