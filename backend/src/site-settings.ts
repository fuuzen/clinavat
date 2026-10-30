import { z } from 'zod';
import type { Store } from './database.js';

const maxImageBytes = 2 * 1024 * 1024;
const maxContentLength = 64 * 1024;
const text = z.string().max(4000, '文字不能超过 4000 个字符');
const richContent = z.string().max(maxContentLength, '内容不能超过 64 KiB');

function validImageSource(value: string): boolean {
  if (value === '') return true;
  if (value.startsWith('data:')) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[1].length % 4 !== 0) return false;
    return Buffer.from(match[1], 'base64').byteLength <= maxImageBytes;
  }
  if (value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  return value.startsWith('/') && !value.startsWith('//');
}

const imageSource = z.string().max(Math.ceil(maxImageBytes / 3) * 4 + 64, '图片不能超过 2 MiB')
  .refine(validImageSource, '图片必须为站内绝对路径或不超过 2 MiB 的 PNG、JPEG、WebP 图片');

const loginTextsSchema = z.object({
  eyebrow: text, previewTitle: text, previewEnvironment: text, previewAccount: text,
  previewPrompt: text, formEyebrow: text, loginTitle: text, loginDescription: text,
  registerTitle: text, registerDescription: text, setupTitle: text, setupDescription: text,
  usernameLabel: text, usernamePlaceholder: text, passwordLabel: text, passwordPlaceholder: text,
  newPasswordPlaceholder: text, loginSubmit: text, registerSubmit: text, setupSubmit: text,
  busySubmit: text, registerPrompt: text, loginPrompt: text, registerLink: text, loginLink: text,
  securityNote: text, loginError: text, registerError: text, setupError: text,
  requiredValidation: text, usernameValidation: text, passwordValidation: text, frameTitle: text,
}).strict();

const loginSchema = z.object({
  layout: z.enum(['split', 'centered', 'custom']),
  contentFormat: z.enum(['markdown', 'html']),
  storyContent: richContent,
  footerContent: richContent,
  pageContent: z.string().max(128 * 1024, '整页模板不能超过 128 KiB'),
  customCss: z.string().max(64 * 1024, '自定义 CSS 不能超过 64 KiB'),
  showBrand: z.boolean(), showStory: z.boolean(), showPreview: z.boolean(),
  texts: loginTextsSchema,
}).strict();

const settingsObjectSchema = z.object({
  name: z.string().trim().min(1, '请输入站点名称').max(80, '站点名称不能超过 80 个字符'),
  description: richContent,
  welcome: text,
  logo: imageSource,
  favicon: imageSource,
  theme: z.enum(['forest', 'midnight', 'violet', 'mist', 'paper', 'sky']),
  login: loginSchema,
}).strict();

export const siteSettingsSchema = settingsObjectSchema.superRefine((settings, context) => {
  if (settings.login.layout === 'custom' && settings.login.pageContent.split('{{authForm}}').length !== 2) {
    context.addIssue({ code: 'custom', path: ['login', 'pageContent'],
      message: '整页自定义模板必须且只能包含一个 {{authForm}} 登录表单占位符' });
  }
});

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export const defaultSiteSettings: SiteSettings = {
  name: 'Clinavat',
  description: '一个工作台，连接原生编程智能体与自己的开发环境。\n\n从想法到交付，让协作自然发生。',
  welcome: '代码在你手中，\n可能性在此展开。',
  logo: '', favicon: '', theme: 'forest',
  login: {
    layout: 'split', contentFormat: 'markdown', storyContent: '',
    footerContent: '独立账号槽位 · 远程执行 · 由你掌控',
    pageContent: '', customCss: '', showBrand: true, showStory: true, showPreview: true,
    texts: {
      eyebrow: 'YOUR ENVIRONMENT. YOUR AGENT.',
      previewTitle: 'workspace / your-next-idea',
      previewEnvironment: '连接开发环境',
      previewAccount: '独立账号，专属空间',
      previewPrompt: '今天，一起创造些什么？',
      formEyebrow: 'WELCOME TO {{siteName}}',
      loginTitle: '欢迎回来',
      loginDescription: '登录账号，接着上一次的灵感继续。',
      registerTitle: '创建账号',
      registerDescription: '加入工作台，连接你的开发环境。',
      setupTitle: '建立你的工作台',
      setupDescription: '创建首个管理员账号，开始配置你的号池。',
      usernameLabel: '用户名', usernamePlaceholder: '你的用户名',
      passwordLabel: '密码', passwordPlaceholder: '输入密码',
      newPasswordPlaceholder: '至少 12 位字符',
      loginSubmit: '进入工作台', registerSubmit: '创建账号', setupSubmit: '创建工作台',
      busySubmit: '请稍候…', registerPrompt: '还没有账号？', loginPrompt: '已有账号？',
      registerLink: '创建账号', loginLink: '登录',
      securityNote: '凭据仅保存在你的 {{siteName}} 服务中。',
      loginError: '{{error}}', registerError: '{{error}}', setupError: '{{error}}',
      requiredValidation: '请填写此字段。',
      usernameValidation: '用户名需为 3–40 位字母、数字、下划线、点或短横线。',
      passwordValidation: '密码至少需要 12 位字符。',
      frameTitle: '{{siteName}} · 登录',
    },
  },
};

const savedSettingsSchema = settingsObjectSchema.partial().extend({
  login: loginSchema.partial().extend({ texts: loginTextsSchema.partial().optional() }).optional(),
}).strict();

export class SiteSettingsService {
  constructor(private readonly store: Store) {}

  view(): SiteSettings {
    const row = this.store.get<{ config: string }>('SELECT config FROM site_settings WHERE id=1');
    if (!row) return siteSettingsSchema.parse(defaultSiteSettings);
    try {
      const saved = savedSettingsSchema.parse(JSON.parse(row.config));
      return siteSettingsSchema.parse({
        ...defaultSiteSettings, ...saved,
        login: { ...defaultSiteSettings.login, ...saved.login,
          texts: { ...defaultSiteSettings.login.texts, ...saved.login?.texts } },
      });
    } catch (cause) {
      throw new Error('站点个性化配置损坏，请检查数据库中的 site_settings 配置', { cause });
    }
  }

  update(input: SiteSettings): SiteSettings {
    const settings = siteSettingsSchema.parse(input);
    this.store.run('INSERT INTO site_settings(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config',
      JSON.stringify(settings));
    return settings;
  }
}
