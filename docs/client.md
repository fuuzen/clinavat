# 客户端

Clinavat 客户端把网页版工作台装进 macOS、Windows、Android 和 iOS 应用，Linux 桌面也可以构建。它基于 [Tauri 2](https://v2.tauri.app/)，自身不带工作台页面，而是打开 Hub 托管的同一份网页版前端：界面、登录和数据与浏览器访问一致，Hub 升级后客户端不需要更新。

> 状态：代码已完成。Hub 列表页与网页版前端通过类型检查和构建；原生部分只做过编译检查，尚未在各平台实际运行，见[验证情况](#验证情况)。下一阶段让桌面客户端兼任本机开发机，见[技术路线](roadmap.md#本机开发机下一阶段)。

## 工作方式

```text
客户端窗口
 ├─ Hub 列表：随应用打包的本地页面，负责添加、校验和打开 Hub
 └─ 打开 Hub 后，同一个窗口 ──HTTPS──▶ Hub 的 Web 入口（网页版前端 + /api）
```

- 启动时显示 Hub 列表，选中后窗口直接导航到 Hub 地址。页面来自 Hub 本身，所以 Cookie、来源校验和内容安全策略都与浏览器访问相同。
- **Hub 页面没有任何原生权限。** 客户端命令只开放给随应用打包的 Hub 列表页（`client/src-tauri/capabilities/hub-list.json`）。Hub 页面是远程内容，即使出现 XSS 也调用不到原生能力。
- 窗口只会停留在 Hub 列表和当前打开的 Hub。指向其他网站的链接、`target="_blank"`、`mailto:` 和 `tel:` 都交给系统浏览器或默认程序打开。
- 客户端会向每个页面注入 `window.__CLINAVAT_CLIENT__`，包含平台、版本和返回 Hub 列表的地址。网页版据此显示「切换 Hub」入口，约定见 `frontend/src/client.ts`。

## Hub 地址

### 打包时的默认 Hub

客户端源码中不写任何 Hub 地址，默认地址在构建时从环境变量读取：

| 变量 | 说明 |
| --- | --- |
| `CLINAVAT_CLIENT_HUB_URL` | 默认 Hub 地址，例如 `https://clinavat.example.com`。可以带基础路径，不能包含账号、查询参数或片段；格式无效时构建直接失败 |
| `CLINAVAT_CLIENT_HUB_NAME` | 列表中显示的名称，默认取主机名 |

变量可以参照 `client/.env.example` 写在 `client/.env.local`（已被 Git 忽略），也可以在命令前设置：

```bash
CLINAVAT_CLIENT_HUB_URL=https://clinavat.example.com CLINAVAT_CLIENT_HUB_NAME=团队 Hub npm run tauri build
```

- 首次启动时，默认 Hub 会加入列表并直接打开。没有设置默认 Hub 时，首次启动显示「添加 Hub」。
- 用户删掉默认 Hub 后，它不会再被加回。新版本更换默认地址时，新地址会追加到列表中，已有条目保留。

### 切换与修改

用户可以在 Hub 列表中添加、编辑和删除 Hub，并选择是否「启动时自动打开上次使用的 Hub」。回到 Hub 列表的方式：

| 位置 | 方式 |
| --- | --- |
| 桌面菜单 | 「Hub → 切换 Hub…」，页面打不开时也能用。同一菜单的「重新加载」在 macOS 上是 ⌘R |
| 网页版 | 登录页底部、侧栏用户信息旁的切换按钮，以及“无法连接服务”页面 |
| Android | 系统返回键 |
| 启动时 | 正在自动打开 Hub 时显示「取消」 |

### 地址规则

- 填写在浏览器中访问 Hub 的最终地址，省略协议时按 HTTPS 处理。打开后又跳转到其他域名的地址无法使用。
- 公网 Hub 必须使用 HTTPS。HTTP 只接受本机和内网地址，包括回环地址、私有网段、链路本地地址、`100.64.0.0/10`（Tailscale 等组网工具使用）、IPv6 ULA，以及 `localhost`、`*.local`、`*.home.arpa` 和不带点的主机名。
- 客户端使用的地址必须已加入 Hub 的公开访问地址（「管理面板 → 网关和访问 → 访问配置」，见[部署文档](deployment.md#公开访问与反向代理)），否则登录会因来源校验失败。

## 构建

需要 Node.js 22.13+，以及 [Tauri 列出的系统依赖](https://v2.tauri.app/start/prerequisites/)：Rust 工具链，再加上各平台各自需要的工具。客户端是独立的 npm 项目，不在根目录的 workspaces 中，不影响 Hub 的部署和 Docker 镜像。

```bash
cd client
npm ci
npm run tauri dev      # 桌面开发，Hub 列表页支持热更新
npm run tauri build    # 打包当前平台的安装包
```

| 平台 | 构建环境 | 命令 | 产物 |
| --- | --- | --- | --- |
| macOS | macOS + Xcode 命令行工具 | `npm run tauri build` | `.app`、`.dmg` |
| Windows | Windows + MSVC 生成工具（系统自带 WebView2） | `npm run tauri build` | `.msi`、`.exe` |
| Linux | WebKitGTK 4.1 等开发包 | `npm run tauri build` | `.deb`、`.rpm`、AppImage |
| Android | Android SDK、NDK 和 JDK 17 | 先 `npm run tauri android init`，再 `npm run tauri android build` | APK、AAB |
| iOS | macOS + Xcode | 先 `npm run tauri ios init`，再 `npm run tauri ios build` | IPA |

桌面安装包位于 `client/src-tauri/target/release/bundle/`，移动端工程生成在 `client/src-tauri/gen/`。

### 应用标识与签名

`client/src-tauri/tauri.conf.json` 中的 `identifier` 为 `app.clinavat.client`。正式分发前，请换成你所控制的反向域名，并配置签名：macOS 需要签名和公证，Windows 需要代码签名，Android 需要 keystore，iOS 需要证书和描述文件。如果不想改仓库里的文件，可以在构建时覆盖：

```bash
npm run tauri build -- --config '{"identifier":"com.example.clinavat"}'
```

### 首次生成移动端工程

`tauri android init` 和 `tauri ios init` 会生成 `src-tauri/gen/android` 和 `src-tauri/gen/apple`。按 Tauri 的约定，这两个目录需要提交到仓库。生成后，Android 工程需要调整两处：

1. **系统栏和软键盘。** 模板中的 `MainActivity` 开启了 edge-to-edge，网页会延伸到状态栏和软键盘下方，而工作台没有处理安全区。需要让 WebView 避开它们：

   ```kotlin
   import android.os.Bundle
   import androidx.activity.enableEdgeToEdge
   import androidx.core.view.ViewCompat
   import androidx.core.view.WindowInsetsCompat

   class MainActivity : TauriActivity() {
     override fun onCreate(savedInstanceState: Bundle?) {
       enableEdgeToEdge()
       super.onCreate(savedInstanceState)
       ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
         val bars = insets.getInsets(
           WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
         )
         view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
         WindowInsetsCompat.CONSUMED
       }
     }
   }
   ```

2. **内网 HTTP。** 正式包默认禁止明文流量。如果需要连接内网的 HTTP Hub，把 `gen/android/app/build.gradle.kts` 中 release 配置的 `manifestPlaceholders["usesCleartextTraffic"]` 改为 `"true"`。公网 Hub 请始终使用 HTTPS。

iOS 工程不需要额外调整。构建时会合并 `src-tauri/Info.plist` 和 `Info.ios.plist`，前者提供局域网访问说明，后者让下载的文件出现在「文件」App 中。

## 平台差异

| 能力 | macOS | Windows | Linux | Android | iOS |
| --- | --- | --- | --- | --- | --- |
| 网页引擎 | WKWebView | WebView2 | WebKitGTK | Android WebView | WKWebView |
| 下载文件 | 保存到「下载」并在访达中显示 | 保存到「下载」并在资源管理器中显示 | 保存到「下载」并在文件管理器中显示 | 不支持 | 保存到「文件」App 的 Clinavat 目录 |
| 回到 Hub 列表 | 菜单、网页入口 | 菜单、网页入口 | 菜单、网页入口 | 返回键、网页入口 | 网页入口 |

- 网页版用到了 `color-mix()` 等较新的 CSS，要求 WebKit 16.2 或更高版本。因此 iOS 最低 16.4，macOS 最低 12 且需要把 Safari 更新到 16.2 以上。Windows 的 WebView2 和 Android WebView 会随系统自动更新。
- Android WebView 不支持下载文件，需要下载时请用浏览器访问 Hub。
- iOS 的 WKWebView 会忽略 `target="_blank"`，客户端会把这类链接的点击改为普通导航，再交给系统浏览器打开。
- 只包装网页的应用可能被 App Store 以“功能过少”为由拒绝上架。团队内部分发可以使用 TestFlight、企业签名，或者直接分发安装包。

## 代码结构

```text
client/
  src/                  Hub 列表页（React），复用网页版的样式变量和基础控件
  src-tauri/
    src/hub.rs          Hub 地址规则、当前 Hub，以及打开和关闭 Hub 的命令
    src/navigation.rs   导航策略、外部链接、注入网页版的客户端标记
    src/downloads.rs    下载位置
    src/menu.rs         桌面菜单
    capabilities/       只有 Hub 列表页能调用客户端命令
  vite.config.ts        读取 CLINAVAT_CLIENT_HUB_URL 和 CLINAVAT_CLIENT_HUB_NAME
```

## 验证情况

在 Linux 开发环境中已验证：

- Hub 列表页通过类型检查和构建。默认 Hub 地址会被规范化，地址无效时构建失败。
- 网页版前端通过类型检查和生产构建。「切换 Hub」入口只在检测到客户端标记时渲染。
- Tauri CLI 能正确解析配置，各平台图标已生成。
- 原生部分对 Android（`aarch64-linux-android`）和 macOS（`aarch64-apple-darwin`）目标通过 `cargo check`，没有警告。Windows、Linux 和 iOS 目标无法在这台 Linux 开发机上检查。
- 用临时程序验证了地址规则和导航判定：省略协议时补全为 HTTPS；内网 HTTP 放行；公网 HTTP、带账号的地址和非 http(s) 协议被拒绝。登录页 `srcdoc`、同源 `blob:`、切换地址和外部链接的判定都符合预期。

尚未验证的内容：

- 在各平台实际构建并运行客户端。
- 各平台的导航拦截能否覆盖登录页的 iframe、文件下载和外部链接。
- Android 在远程页面中注入脚本的时机，以及返回键的行为。
- iOS 访问内网 HTTP 地址、下载到「文件」App，以及 `target="_blank"` 链接的改写。
- 在 WKWebView 中，跨源导航后 `SameSite=Strict` 的登录 Cookie 是否正常。
- Windows 上的拖拽上传和剪贴板复制。
