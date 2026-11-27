#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL(".", import.meta.url));
const tauriDir = join(clientDir, "src-tauri");
const genDir = join(tauriDir, "gen");

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;

const REQUIRED_ANDROID_IMPORTS = [
  "import android.os.Bundle",
  "import androidx.activity.enableEdgeToEdge",
  "import androidx.core.view.ViewCompat",
  "import androidx.core.view.WindowInsetsCompat",
];

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[prepare-mobile] ${message}`);
}

function readOptionalIdentifier() {
  const value = process.env.CLINAVAT_CLIENT_IDENTIFIER?.trim() ?? "";
  if (!value) return null;
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail(
      `Invalid CLINAVAT_CLIENT_IDENTIFIER "${value}". Expected a reverse-DNS bundle identifier (e.g. com.example.clinavat).`,
    );
  }
  return value;
}

function runTauriInit(target, configOverride) {
  let tempDir = null;
  const args = ["tauri", target, "init", "--ci"];

  try {
    if (configOverride && Object.keys(configOverride).length > 0) {
      // Pass overrides via a temporary JSON file so Windows cmd.exe never strips quotes.
      tempDir = mkdtempSync(join(tmpdir(), "clinavat-tauri-config-"));
      const configPath = join(tempDir, "tauri-override.json");
      writeFileSync(configPath, `${JSON.stringify(configOverride, null, 2)}\n`, "utf8");
      args.push("--config", configPath);
    }

    log(`Running: npx ${args.join(" ")}`);
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const result = spawnSync(command, args, {
      cwd: clientDir,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });

    if (result.error) {
      fail(`Failed to launch "${command}": ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`"npx ${args.join(" ")}" exited with code ${result.status ?? "unknown"}`);
    }
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function findFilesNamed(rootDir, fileName) {
  const matches = [];
  if (!existsSync(rootDir)) return matches;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(fullPath);
      }
    }
  }
  return matches.sort();
}

function ensureKotlinImports(source, requiredImports) {
  const missing = requiredImports.filter((line) => !new RegExp(`^${escapeRegExp(line)}\\s*$`, "m").test(source));
  if (missing.length === 0) return source;

  const lines = source.split(/\r?\n/);
  let lastImportIndex = -1;
  let packageIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+/.test(lines[i])) {
      lastImportIndex = i;
    } else if (packageIndex === -1 && /^\s*package\s+/.test(lines[i])) {
      packageIndex = i;
    }
  }

  if (lastImportIndex !== -1) {
    lines.splice(lastImportIndex + 1, 0, ...missing);
    return lines.join("\n");
  }

  if (packageIndex !== -1) {
    lines.splice(packageIndex + 1, 0, "", ...missing);
    return lines.join("\n");
  }

  fail("MainActivity.kt is missing both package and import declarations; refusing to guess injection point.");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildInsetsBlock(indent) {
  return [
    `${indent}ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->`,
    `${indent}  val bars = insets.getInsets(`,
    `${indent}    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),`,
    `${indent}  )`,
    `${indent}  view.setPadding(bars.left, bars.top, bars.right, bars.bottom)`,
    `${indent}  WindowInsetsCompat.CONSUMED`,
    `${indent}}`,
  ].join("\n");
}

function patchMainActivity(androidDir) {
  const searchRoot = join(androidDir, "app", "src", "main");
  const candidates = findFilesNamed(searchRoot, "MainActivity.kt");

  if (candidates.length === 0) {
    fail(`Could not locate MainActivity.kt under ${relative(clientDir, searchRoot)}`);
  }
  if (candidates.length > 1) {
    fail(
      `Expected a single MainActivity.kt, found ${candidates.length}: ${candidates.map((p) => relative(clientDir, p)).join(", ")}`,
    );
  }

  const mainActivityPath = candidates[0];
  const relPath = relative(clientDir, mainActivityPath);
  const original = readFileSync(mainActivityPath, "utf8");

  if (
    original.includes("ViewCompat.setOnApplyWindowInsetsListener") &&
    original.includes("WindowInsetsCompat.Type.systemBars()")
  ) {
    log(`MainActivity safe-area insets already configured (${relPath})`);
    return;
  }

  if (!/class\s+MainActivity\s*:\s*TauriActivity\s*\(\s*\)/.test(original)) {
    fail(`Expected "class MainActivity : TauriActivity()" anchor in ${relPath}`);
  }

  let updated = ensureKotlinImports(original, REQUIRED_ANDROID_IMPORTS);
  const superOnCreateRe = /^([ \t]*)super\.onCreate\(savedInstanceState\)[ \t]*$/m;
  const emptyClassRe = /^([ \t]*)class\s+MainActivity\s*:\s*TauriActivity\s*\(\s*\)\s*(?:\{\s*\})?[ \t]*$/m;

  if (superOnCreateRe.test(updated)) {
    const hasEnableEdgeToEdge = /\benableEdgeToEdge\s*\(\s*\)/.test(updated);
    updated = updated.replace(superOnCreateRe, (_match, indent) => {
      const prefix = hasEnableEdgeToEdge ? "" : `${indent}enableEdgeToEdge()\n`;
      return `${prefix}${indent}super.onCreate(savedInstanceState)\n${buildInsetsBlock(indent)}`;
    });
  } else if (emptyClassRe.test(updated)) {
    updated = updated.replace(emptyClassRe, (_match, indent) => {
      const methodIndent = `${indent}  `;
      const bodyIndent = `${indent}    `;
      return [
        `${indent}class MainActivity : TauriActivity() {`,
        `${methodIndent}override fun onCreate(savedInstanceState: Bundle?) {`,
        `${bodyIndent}enableEdgeToEdge()`,
        `${bodyIndent}super.onCreate(savedInstanceState)`,
        buildInsetsBlock(bodyIndent),
        `${methodIndent}}`,
        `${indent}}`,
      ].join("\n");
    });
  } else {
    fail(
      `Could not find "super.onCreate(savedInstanceState)" or empty "class MainActivity : TauriActivity()" anchor in ${relPath}`,
    );
  }

  if (
    !updated.includes("ViewCompat.setOnApplyWindowInsetsListener") ||
    !updated.includes("WindowInsetsCompat.Type.systemBars()")
  ) {
    fail(`Safe-area insets verification failed after patching ${relPath}`);
  }

  if (!updated.endsWith("\n")) {
    updated += "\n";
  }

  writeFileSync(mainActivityPath, updated, "utf8");
  log(`Injected WindowInsetsCompat safe-area handling into ${relPath}`);
}

function findBraceBlock(source, headerRegex) {
  const match = headerRegex.exec(source);
  if (!match) return null;

  const openBraceIndex = source.indexOf("{", match.index);
  if (openBraceIndex === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: openBraceIndex, end: i + 1 };
      }
    }
  }

  return null;
}

function patchAndroidGradle(androidDir) {
  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  const relPath = relative(clientDir, gradlePath);
  if (!existsSync(gradlePath)) {
    fail(`Missing expected Gradle file: ${relPath}`);
  }

  const cleartext = process.env.CLINAVAT_ANDROID_CLEARTEXT === "true" ? "true" : "false";
  const original = readFileSync(gradlePath, "utf8");
  const placeholderRe = /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"(?:true|false)"/;

  const defaultConfigSpan = findBraceBlock(original, /\bdefaultConfig\s*\{/);
  if (!defaultConfigSpan) {
    fail(`Could not locate "defaultConfig { ... }" block in ${relPath}`);
  }

  const defaultConfigBody = original.slice(defaultConfigSpan.start, defaultConfigSpan.end);
  if (!placeholderRe.test(defaultConfigBody)) {
    fail(`Could not locate manifestPlaceholders["usesCleartextTraffic"] inside defaultConfig in ${relPath}`);
  }

  const updatedDefaultConfig = defaultConfigBody.replace(
    placeholderRe,
    `manifestPlaceholders["usesCleartextTraffic"] = "${cleartext}"`,
  );
  let updated =
    original.slice(0, defaultConfigSpan.start) + updatedDefaultConfig + original.slice(defaultConfigSpan.end);

  // If a release buildType explicitly overrides usesCleartextTraffic, keep it aligned too without touching debug.
  const releaseSpan = findBraceBlock(updated, /\bgetByName\(\s*"release"\s*\)\s*\{/);
  if (releaseSpan) {
    const releaseBody = updated.slice(releaseSpan.start, releaseSpan.end);
    if (placeholderRe.test(releaseBody)) {
      const updatedRelease = releaseBody.replace(
        placeholderRe,
        `manifestPlaceholders["usesCleartextTraffic"] = "${cleartext}"`,
      );
      updated = updated.slice(0, releaseSpan.start) + updatedRelease + updated.slice(releaseSpan.end);
    }
  }

  if (updated === original) {
    log(`Gradle usesCleartextTraffic already set to "${cleartext}" (${relPath})`);
    return;
  }

  writeFileSync(gradlePath, updated, "utf8");
  log(`Set usesCleartextTraffic = "${cleartext}" in ${relPath}`);
}

function prepareAndroid() {
  const androidDir = join(genDir, "android");
  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  const identifier = readOptionalIdentifier();

  if (!existsSync(gradlePath)) {
    const configOverride = identifier ? { identifier } : null;
    runTauriInit("android", configOverride);
  } else {
    log(`Android project already initialized (${relative(clientDir, androidDir)})`);
  }

  patchMainActivity(androidDir);
  patchAndroidGradle(androidDir);
  log("Android project preparation completed.");
}

function hasIosProject(appleDir) {
  if (!existsSync(appleDir)) return false;
  if (existsSync(join(appleDir, "project.yml"))) return true;
  return readdirSync(appleDir).some((entry) => entry.endsWith(".xcodeproj"));
}

function prepareIos() {
  if (process.platform !== "darwin") {
    fail("iOS project preparation requires macOS with Xcode installed.");
  }

  const appleDir = join(genDir, "apple");
  const identifier = readOptionalIdentifier();
  const developmentTeam = process.env.APPLE_DEVELOPMENT_TEAM?.trim() ?? "";

  if (!hasIosProject(appleDir)) {
    const configOverride = {};
    if (identifier) {
      configOverride.identifier = identifier;
    }
    if (developmentTeam) {
      configOverride.bundle = { iOS: { developmentTeam } };
    }
    runTauriInit("ios", configOverride);
  } else {
    log(`iOS project already initialized (${relative(clientDir, appleDir)})`);
  }

  if (!hasIosProject(appleDir)) {
    fail(`Expected iOS project files under ${relative(clientDir, appleDir)} after tauri ios init.`);
  }

  log("iOS project preparation completed.");
}

function main() {
  const target = process.argv[2]?.trim().toLowerCase();
  if (target === "android") {
    prepareAndroid();
    return;
  }
  if (target === "ios") {
    prepareIos();
    return;
  }

  fail("Usage: node client/prepare-mobile.mjs <android|ios>");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prepare-mobile] ERROR: ${message}`);
  process.exitCode = 1;
}
