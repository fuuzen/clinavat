#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const tauriDir = join(clientDir, "src-tauri");
const daemonDir = join(clientDir, "daemon");

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const LEGACY_IOS_EXPORT_METHODS = {
  "ad-hoc": "release-testing",
  "app-store": "app-store-connect",
  development: "debugging",
};
const VALID_IOS_EXPORT_METHODS = new Set([
  "release-testing",
  "app-store-connect",
  "debugging",
]);

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[release-tools] ${message}`);
}

function readPackageJsonVersion() {
  const pkgPath = join(clientDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) fail(`Missing "version" in ${pkgPath}`);
  return version;
}

function readCargoPackageVersion(tomlPath) {
  const content = readFileSync(tomlPath, "utf8");
  let inPackage = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"$/.exec(line);
      if (match) return match[1].trim();
    }
  }
  fail(`Missing [package].version in ${tomlPath}`);
}

function assertVersionConsistency() {
  const packageVersion = readPackageJsonVersion();
  const tauriVersion = readCargoPackageVersion(join(tauriDir, "Cargo.toml"));
  const daemonVersion = readCargoPackageVersion(join(daemonDir, "Cargo.toml"));

  if (!VERSION_PATTERN.test(packageVersion)) {
    fail(`Invalid client version "${packageVersion}" in client/package.json`);
  }
  if (packageVersion !== tauriVersion || packageVersion !== daemonVersion) {
    fail(
      [
        "Client version mismatch detected:",
        `  client/package.json:         ${packageVersion}`,
        `  client/src-tauri/Cargo.toml: ${tauriVersion}`,
        `  client/daemon/Cargo.toml:    ${daemonVersion}`,
      ].join("\n"),
    );
  }
  return packageVersion;
}

function validateOptionalHubUrl(raw) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Invalid CLINAVAT_CLIENT_HUB_URL "${value}": must be a valid http(s) URL.`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      `Invalid CLINAVAT_CLIENT_HUB_URL "${value}": must be http(s) without credentials, query, or fragment.`,
    );
  }
  return url.href;
}

function validateOptionalIdentifier(raw) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail(
      `Invalid CLINAVAT_CLIENT_IDENTIFIER "${value}": expected reverse-DNS format (e.g. com.example.clinavat).`,
    );
  }
  return value;
}

function normalizeIosExportMethod(raw) {
  const value = (raw ?? "").trim();
  if (!value) return "release-testing";
  const normalized = LEGACY_IOS_EXPORT_METHODS[value] ?? value;
  if (!VALID_IOS_EXPORT_METHODS.has(normalized)) {
    fail(
      `Invalid APPLE_IOS_EXPORT_METHOD "${value}". Expected one of: release-testing, app-store-connect, debugging (or legacy ad-hoc, app-store, development).`,
    );
  }
  return normalized;
}

export function writeGithubFile(filePath, pairs) {
  if (!filePath) {
    console.log(JSON.stringify(pairs, null, 2));
    return;
  }
  const delimiter = `EOF_${randomBytes(12).toString("hex")}`;
  let payload = "";
  for (const [key, rawValue] of Object.entries(pairs)) {
    const value = String(rawValue ?? "");
    if (value.includes("\n") || value.includes("\r")) {
      payload += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    } else {
      payload += `${key}=${value}\n`;
    }
  }
  appendFileSync(filePath, payload, "utf8");
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function cmdCheckVersions() {
  const version = assertVersionConsistency();
  log(`Client versions consistent: ${version}`);
}

function cmdPrepareRelease() {
  const version = assertVersionConsistency();
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const refName = process.env.GITHUB_REF_NAME ?? "";
  const sha = (process.env.GITHUB_SHA ?? "0000000").slice(0, 7);

  const isTagPush = eventName === "push" && refName.startsWith("client-v");
  let artifactVersion;
  let releaseTag;
  let shouldRelease;
  let isPrerelease;
  let buildDesktop;
  let buildAndroid;
  let buildIos;
  let hubUrl;
  let hubName;
  let androidCleartext;

  if (isTagPush) {
    const tagVersion = refName.slice("client-v".length);
    if (!tagVersion || tagVersion !== version) {
      fail(
        `Tag "${refName}" expects version "${tagVersion}", but client manifests are at "${version}". Keep tag, client/package.json, client/src-tauri/Cargo.toml, and client/daemon/Cargo.toml identical.`,
      );
    }
    artifactVersion = version;
    releaseTag = refName;
    shouldRelease = true;
    isPrerelease = version.includes("-");
    buildDesktop = true;
    buildAndroid = true;
    buildIos = true;
    hubUrl = validateOptionalHubUrl(process.env.VAR_HUB_URL);
    hubName = (process.env.VAR_HUB_NAME ?? "").trim();
    androidCleartext = parseBool(process.env.VAR_ANDROID_CLEARTEXT, false);
  } else {
    artifactVersion = `${version}-${sha}`;
    releaseTag = `client-v${artifactVersion}`;
    shouldRelease = parseBool(process.env.INPUT_CREATE_RELEASE, false);
    isPrerelease = true;
    buildDesktop = parseBool(process.env.INPUT_BUILD_DESKTOP, true);
    buildAndroid = parseBool(process.env.INPUT_BUILD_ANDROID, true);
    buildIos = parseBool(process.env.INPUT_BUILD_IOS, true);
    if (!buildDesktop && !buildAndroid && !buildIos) {
      fail("At least one platform (build_desktop, build_android, build_ios) must be enabled.");
    }
    const rawHubUrl = (process.env.INPUT_HUB_URL ?? "").trim() || (process.env.VAR_HUB_URL ?? "").trim();
    hubUrl = validateOptionalHubUrl(rawHubUrl);
    hubName = (process.env.INPUT_HUB_NAME ?? "").trim() || (process.env.VAR_HUB_NAME ?? "").trim();
    androidCleartext = parseBool(
      process.env.INPUT_ANDROID_CLEARTEXT || process.env.VAR_ANDROID_CLEARTEXT,
      false,
    );
  }

  const identifier = validateOptionalIdentifier(process.env.VAR_IDENTIFIER);
  const iosExportMethod = normalizeIosExportMethod(process.env.VAR_IOS_EXPORT_METHOD);

  writeGithubFile(process.env.GITHUB_OUTPUT, {
    version,
    artifact_version: artifactVersion,
    release_tag: releaseTag,
    should_release: String(shouldRelease),
    is_prerelease: String(isPrerelease),
    build_desktop: String(buildDesktop),
    build_android: String(buildAndroid),
    build_ios: String(buildIos),
    hub_url: hubUrl,
    hub_name: hubName,
    identifier,
    android_cleartext: String(androidCleartext),
    ios_export_method: iosExportMethod,
  });
  log(
    `Prepared build ${artifactVersion} (tag=${releaseTag}, release=${shouldRelease}, desktop=${buildDesktop}, android=${buildAndroid}, ios=${buildIos})`,
  );
}

function cmdWriteTauriConfig(outputPath) {
  if (!outputPath) fail("Usage: node client/release-tools.mjs write-tauri-config <output-path>");
  const resolvedPath = resolve(outputPath);
  const config = {};

  const identifier = validateOptionalIdentifier(process.env.CLINAVAT_CLIENT_IDENTIFIER);
  if (identifier) {
    config.identifier = identifier;
  }

  const winThumbprint = (process.env.WINDOWS_CERT_THUMBPRINT ?? "").trim();
  if (winThumbprint) {
    const timestampUrl =
      (process.env.WINDOWS_TIMESTAMP_URL ?? "").trim() || "http://timestamp.digicert.com";
    config.bundle = {
      windows: {
        certificateThumbprint: winThumbprint,
        digestAlgorithm: "sha256",
        timestampUrl,
      },
    };
  }

  if (Object.keys(config).length === 0) {
    rmSync(resolvedPath, { force: true });
    writeGithubFile(process.env.GITHUB_ENV, { TAURI_CONFIG_PATH: "" });
    log("No Tauri config overrides required.");
    return;
  }

  writeFileSync(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeGithubFile(process.env.GITHUB_ENV, { TAURI_CONFIG_PATH: resolvedPath });
  log(`Wrote Tauri config override to ${resolvedPath}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function cmdWriteReleaseNotes(assetsDir, outputFile) {
  if (!assetsDir || !outputFile) {
    fail("Usage: node client/release-tools.mjs write-release-notes <assets-dir> <output-file>");
  }
  const resolvedDir = resolve(assetsDir);
  const files = readdirSync(resolvedDir)
    .filter((name) => statSync(join(resolvedDir, name)).isFile())
    .sort((a, b) => a.localeCompare(b, "en"));

  const version = process.env.ARTIFACT_VERSION || readPackageJsonVersion();
  const hubUrl = (process.env.CLINAVAT_CLIENT_HUB_URL ?? "").trim();
  const hubName = (process.env.CLINAVAT_CLIENT_HUB_NAME ?? "").trim();
  const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7);

  const hasMac = files.some((f) => f.endsWith(".dmg"));
  const hasSelfSignedAndroid = files.some((f) => f.endsWith("_selfsigned.apk"));
  const hasUnsignedIos = files.some((f) => f.endsWith("_unsigned.ipa"));

  const lines = [
    `## Clinavat Client ${version}`,
    "",
    sha ? `- Commit: \`${sha}\`` : null,
    hubUrl
      ? `- 预置默认 Hub: \`${hubUrl}\`${hubName ? ` (${hubName})` : ""}`
      : "- 预置默认 Hub: 未预设（首次启动可手动添加 Hub）",
    "",
    "### 构建产物",
    "",
    "| 文件 | 大小 |",
    "| --- | ---: |",
    ...files.map((name) => {
      const size = formatBytes(statSync(join(resolvedDir, name)).size);
      return `| \`${name}\` | ${size} |`;
    }),
    "",
    "### 校验与安装说明",
    "",
    "- 使用 `SHA256SUMS.txt` 校验文件完整性：`sha256sum -c SHA256SUMS.txt`（macOS 可使用 `shasum -a 256 -c SHA256SUMS.txt`）。",
  ].filter((line) => line !== null);

  if (hasMac) {
    lines.push(
      "- **macOS**：若未配置 Developer ID 公证证书，安装包为 ad-hoc 签名；首次打开时请在「系统设置 → 隐私与安全性」中点击「仍要打开」。",
    );
  }
  if (hasSelfSignedAndroid) {
    lines.push(
      "- **Android (`*_selfsigned.apk`)**：使用临时密钥库自签名，可在真机直接安装测试；如需覆盖升级请配置固定 `ANDROID_KEYSTORE_*` Secrets。",
    );
  }
  if (hasUnsignedIos) {
    lines.push(
      "- **iOS (`*_unsigned.ipa`)**：未签名 IPA，请使用 AltStore / SideStore / Sideloadly 等工具自签后安装；配置 `APPLE_IOS_*` Secrets 后将自动切换为正式签名导出。",
    );
  }

  writeFileSync(resolve(outputFile), `${lines.join("\n")}\n`, "utf8");
  log(`Wrote release notes to ${outputFile}`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "check-versions":
      cmdCheckVersions();
      return;
    case "prepare-release":
      cmdPrepareRelease();
      return;
    case "write-tauri-config":
      cmdWriteTauriConfig(args[0]);
      return;
    case "write-release-notes":
      cmdWriteReleaseNotes(args[0], args[1]);
      return;
    default:
      fail(
        "Usage: node client/release-tools.mjs <check-versions|prepare-release|write-tauri-config|write-release-notes>",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release-tools] ERROR: ${message}`);
    process.exitCode = 1;
  }
}
