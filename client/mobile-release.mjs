#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGithubFile } from "./release-tools.mjs";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const tauriDir = join(clientDir, "src-tauri");

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[mobile-release] ${message}`);
}

function escapeJavaProperty(value) {
  if (/[\r\n]/.test(value)) {
    fail("Android keystore property values must not contain newlines.");
  }
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([:=])/g, "\\$1")
    .replace(/^ /, "\\ ");
}

function findBraceBlock(source, headerRegex) {
  const match = headerRegex.exec(source);
  if (!match) return null;
  const openIndex = source.indexOf("{", match.index);
  if (openIndex === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start: openIndex, end: i + 1, headerStart: match.index };
    }
  }
  return null;
}

function cmdPatchAndroidSigning() {
  const androidDir = process.env.CLINAVAT_ANDROID_DIR
    ? resolve(process.env.CLINAVAT_ANDROID_DIR)
    : join(tauriDir, "gen", "android");
  const keystorePath = (process.env.ANDROID_KEYSTORE_PATH ?? "").trim();
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD ?? "";
  const keyAlias = (process.env.ANDROID_KEY_ALIAS ?? "").trim();
  const keyPassword = process.env.ANDROID_KEY_PASSWORD || storePassword;

  if (!keystorePath || !storePassword || !keyAlias) {
    fail("ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, and ANDROID_KEY_ALIAS are required.");
  }

  const propertiesPath = join(androidDir, "keystore.properties");
  const propertiesBody = [
    `storeFile=${escapeJavaProperty(keystorePath)}`,
    `storePassword=${escapeJavaProperty(storePassword)}`,
    `keyAlias=${escapeJavaProperty(keyAlias)}`,
    `keyPassword=${escapeJavaProperty(keyPassword)}`,
    "",
  ].join("\n");
  writeFileSync(propertiesPath, propertiesBody, { encoding: "utf8", mode: 0o600 });

  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  if (!existsSync(gradlePath)) {
    fail(`Missing Gradle build file: ${gradlePath}`);
  }
  let gradle = readFileSync(gradlePath, "utf8");

  if (!gradle.includes('rootProject.file("keystore.properties")')) {
    const buildTypesSpan = findBraceBlock(gradle, /\bbuildTypes\s*\{/);
    if (!buildTypesSpan) {
      fail(`Could not locate buildTypes block in ${gradlePath}`);
    }
    const signingBlock = [
      "    signingConfigs {",
      '        create("release") {',
      '            val keystorePropertiesFile = rootProject.file("keystore.properties")',
      "            val keystoreProperties = java.util.Properties()",
      "            if (keystorePropertiesFile.exists()) {",
      "                java.io.FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }",
      "            }",
      '            keyAlias = keystoreProperties.getProperty("keyAlias")',
      '            keyPassword = keystoreProperties.getProperty("keyPassword")',
      '            storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }',
      '            storePassword = keystoreProperties.getProperty("storePassword")',
      "        }",
      "    }",
      "",
      "    ",
    ].join("\n");
    gradle =
      gradle.slice(0, buildTypesSpan.headerStart) +
      signingBlock +
      gradle.slice(buildTypesSpan.headerStart);
  }

  const releaseSpan = findBraceBlock(gradle, /\bgetByName\(\s*"release"\s*\)\s*\{/);
  if (!releaseSpan) {
    fail(`Could not locate getByName("release") block in ${gradlePath}`);
  }
  const releaseBody = gradle.slice(releaseSpan.start, releaseSpan.end);
  if (!releaseBody.includes('signingConfigs.getByName("release")')) {
    const injected = releaseBody.replace(
      /^\{\r?\n?/,
      '{\n            signingConfig = signingConfigs.getByName("release")\n',
    );
    gradle = gradle.slice(0, releaseSpan.start) + injected + gradle.slice(releaseSpan.end);
  }

  writeFileSync(gradlePath, gradle, "utf8");
  log(`Configured release signing in ${gradlePath}`);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`Failed to run "${command}": ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `Command "${command} ${args.join(" ")}" failed with exit code ${result.status}:\n${result.stderr || result.stdout || ""}`,
    );
  }
  return result.stdout ?? "";
}

function cmdPrepareIosUnsigned() {
  const appleDir = process.env.CLINAVAT_APPLE_DIR
    ? resolve(process.env.CLINAVAT_APPLE_DIR)
    : join(tauriDir, "gen", "apple");
  const projectYmlPath = join(appleDir, "project.yml");
  if (!existsSync(projectYmlPath)) {
    fail(`Missing iOS XcodeGen file: ${projectYmlPath}`);
  }

  // Ruby ships with macOS and provides spec-compliant YAML parsing/dumping with zero extra dependencies.
  const rubyScript = `
    require 'yaml'
    require 'json'

    path = ARGV[0]
    doc = YAML.load_file(path)
    raise 'Invalid project.yml' unless doc.is_a?(Hash)

    targets = doc['targets']
    raise 'No targets found in project.yml' unless targets.is_a?(Hash) && !targets.empty?

    target_name, target = targets.find { |_k, v| v.is_a?(Hash) && v['platform'] == 'iOS' && v['type'] == 'application' }
    target_name, target = targets.first if target_name.nil?

    configs = doc['configs'] || {}
    release_config = configs.find { |_k, v| v.to_s.downcase == 'release' }&.first || 'release'

    if target['preBuildScripts'].is_a?(Array)
      target['preBuildScripts'].reject! do |entry|
        entry.is_a?(Hash) && (
          entry['name'].to_s.strip == 'Build Rust Code' ||
          entry['script'].to_s.include?('xcode-script')
        )
      end
      target.delete('preBuildScripts') if target['preBuildScripts'].empty?
    end

    clear_dummy_team = lambda do |node|
      if node.is_a?(Hash)
        node.delete('DEVELOPMENT_TEAM') if node['DEVELOPMENT_TEAM'].to_s == '0000000000'
        node.each_value { |v| clear_dummy_team.call(v) }
      elsif node.is_a?(Array)
        node.each { |v| clear_dummy_team.call(v) }
      end
    end
    clear_dummy_team.call(doc)

    info_plist = target.dig('settings', 'base', 'INFOPLIST_FILE') || "\#{target_name}/Info.plist"
    scheme_name = (doc['schemes'].is_a?(Hash) && doc['schemes'].keys.first) || target_name
    project_name = doc['name'] || 'app'

    File.write(path, YAML.dump(doc))
    puts JSON.generate({
      project_name: project_name,
      target_name: target_name,
      scheme_name: scheme_name,
      release_config: release_config,
      info_plist: info_plist,
    })
  `;

  const meta = JSON.parse(runChecked("ruby", ["-e", rubyScript, projectYmlPath]).trim());
  log(`Patched ${projectYmlPath} (target=${meta.target_name}, config=${meta.release_config})`);

  if (process.env.CLINAVAT_SKIP_XCODEGEN !== "true") {
    runChecked("xcodegen", ["generate"], { cwd: appleDir, stdio: "inherit" });
  }

  const targetPlistPath = resolve(appleDir, meta.info_plist);
  const plistSources = [join(tauriDir, "Info.plist"), join(tauriDir, "Info.ios.plist")].filter(
    (p) => existsSync(p),
  );

  if (existsSync(targetPlistPath) && plistSources.length > 0) {
    const pyScript = `
import plistlib, sys

def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v

target_path = sys.argv[1]
with open(target_path, "rb") as f:
    merged = plistlib.load(f)

for src_path in sys.argv[2:]:
    with open(src_path, "rb") as f:
        deep_merge(merged, plistlib.load(f))

with open(target_path, "wb") as f:
    plistlib.dump(merged, f, fmt=plistlib.FMT_XML, sort_keys=True)
`;
    runChecked("python3", ["-c", pyScript, targetPlistPath, ...plistSources]);
    log(`Merged ${plistSources.length} plist overlay(s) into ${targetPlistPath}`);
  }

  const xcodeProject = join(appleDir, `${meta.project_name}.xcodeproj`);
  const libappDest = join(appleDir, "Externals", "arm64", meta.release_config, "libapp.a");

  writeGithubFile(process.env.GITHUB_ENV, {
    XCODE_PROJECT: xcodeProject,
    XCODE_SCHEME: meta.scheme_name,
    XCODE_CONFIG: meta.release_config,
    LIBAPP_DEST: libappDest,
  });
  log(`Prepared unsigned iOS project metadata (libapp -> ${libappDest})`);
}

function main() {
  const [command] = process.argv.slice(2);
  switch (command) {
    case "patch-android-signing":
      cmdPatchAndroidSigning();
      return;
    case "prepare-ios-unsigned":
      cmdPrepareIosUnsigned();
      return;
    default:
      fail("Usage: node client/mobile-release.mjs <patch-android-signing|prepare-ios-unsigned>");
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mobile-release] ERROR: ${message}`);
  process.exitCode = 1;
}
