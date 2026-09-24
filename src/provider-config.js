/**
 * Which AI provider a run uses, and the saved default behind it.
 *
 * Precedence: --claude/--codex > REVIEW_AI_PROVIDER > saved default. With no
 * saved default, an interactive terminal is asked once and the answer saved;
 * anything else falls back to Claude when an Anthropic key is available, then
 * to Codex when its CLI is on PATH.
 *
 * bin/review runs this file as a CLI; the generator, tip resolver and dev
 * server import `resolveProviderSync`, which never prompts.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join, resolve } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";

export const PROVIDERS = ["claude", "codex"];
const LABEL = { claude: "Claude", codex: "Codex" };
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeProvider(value, source = "provider") {
  const provider = String(value || "").trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported ${source}: "${value}". Expected "claude" or "codex".`);
  }
  return provider;
}

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "ai-pr-review", "config.json");
}

export function readSavedProvider(env = process.env) {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${err.message}. Fix or delete it, or run: review --set-default claude|codex`);
  }
  return config?.provider ? normalizeProvider(config.provider, `provider in ${path}`) : null;
}

export function saveProvider(provider, env = process.env) {
  const path = configPath(env);
  let config = {};
  try {
    config = JSON.parse(readFileSync(path, "utf-8")) || {};
  } catch {}
  config.provider = normalizeProvider(provider);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

export function hasAnthropicKey(env = process.env, toolRoot = TOOL_ROOT) {
  if (env.ANTHROPIC_API_KEY) return true;
  const envFile = join(toolRoot, ".env");
  if (!existsSync(envFile)) return false;
  return readFileSync(envFile, "utf-8")
    .split("\n")
    .some((line) => /^ANTHROPIC_(?:API_)?KEY=\S/.test(line) && !/=sk-ant-\.\.\.\s*$/.test(line));
}

export function hasCodexCli(env = process.env) {
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "codex"), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function fallbackProvider(env, toolRoot) {
  if (hasAnthropicKey(env, toolRoot)) return { provider: "claude", source: "fallback: Anthropic API key found" };
  if (hasCodexCli(env)) return { provider: "codex", source: "fallback: codex CLI found" };
  throw new Error(
    "No AI provider available: set ANTHROPIC_API_KEY (or add it to .env) for Claude, " +
      "or install and log in to the Codex CLI. Then run: review --set-default claude|codex"
  );
}

/** Resolution without prompting — for non-interactive callers. */
export function resolveProviderSync({ flag = null, env = process.env, toolRoot = TOOL_ROOT } = {}) {
  if (flag) return { provider: normalizeProvider(flag), source: `--${normalizeProvider(flag)}` };
  if (env.REVIEW_AI_PROVIDER) {
    return { provider: normalizeProvider(env.REVIEW_AI_PROVIDER, "REVIEW_AI_PROVIDER"), source: "REVIEW_AI_PROVIDER" };
  }
  const saved = readSavedProvider(env);
  if (saved) return { provider: saved, source: "saved default" };
  return fallbackProvider(env, toolRoot);
}

async function askForDefault({ input, output, env, toolRoot }) {
  const claudeReady = hasAnthropicKey(env, toolRoot);
  const codexReady = hasCodexCli(env);
  const suggested = claudeReady || !codexReady ? "claude" : "codex";
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  output.write(
    "\nWhich AI should generate walkthroughs by default?\n" +
      `  1) Claude — Anthropic API${claudeReady ? " (key found)" : " (needs ANTHROPIC_API_KEY)"}\n` +
      `  2) Codex  — Codex CLI${codexReady ? " (found)" : " (not found on PATH)"}\n`
  );
  try {
    for (;;) {
      output.write(`Choose 1 or 2 [${suggested === "claude" ? 1 : 2}]: `);
      const { value, done } = await lines.next();
      if (done) return suggested;
      const answer = value.trim().toLowerCase();
      if (!answer) return suggested;
      if (answer === "1" || answer === "claude") return "claude";
      if (answer === "2" || answer === "codex") return "codex";
      output.write("Please answer 1 (Claude) or 2 (Codex).\n");
    }
  } finally {
    rl.close();
  }
}

/**
 * Full resolution for a CLI run. `setDefault` saves a new default first; a
 * missing default is asked for only when `interactive` is true.
 */
export async function chooseProvider({
  flag = null,
  setDefault = null,
  env = process.env,
  interactive = false,
  input = process.stdin,
  output = process.stderr,
  toolRoot = TOOL_ROOT,
} = {}) {
  if (setDefault) saveProvider(setDefault, env);
  if (flag || env.REVIEW_AI_PROVIDER || readSavedProvider(env)) {
    return resolveProviderSync({ flag, env, toolRoot });
  }
  if (!interactive) return fallbackProvider(env, toolRoot);
  const provider = await askForDefault({ input, output, env, toolRoot });
  const path = saveProvider(provider, env);
  output.write(`Saved ${LABEL[provider]} as the default in ${path}\n`);
  return { provider, source: "saved default" };
}

export function describeChoice({ provider, source }) {
  const other = provider === "claude" ? "codex" : "claude";
  return `AI provider: ${LABEL[provider]} (${source}) — --${other} for one run, review --set-default ${other} to change the default`;
}

/**
 * Pull provider options out of an argument list, leaving everything else in
 * order. Accepts `--set-default X` and `--set-default=X`.
 */
export function parseProviderArgs(argv) {
  const rest = [];
  let flag = null;
  let setDefault = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--claude" || arg === "--codex") {
      flag = arg.slice(2);
    } else if (arg === "--set-default") {
      if (i + 1 >= argv.length) throw new Error("--set-default needs a value: claude or codex");
      setDefault = normalizeProvider(argv[++i], "--set-default value");
    } else if (arg.startsWith("--set-default=")) {
      setDefault = normalizeProvider(arg.slice("--set-default=".length), "--set-default value");
    } else {
      rest.push(arg);
    }
  }
  return { flag, setDefault, rest };
}

// CLI used by bin/review:
//   node src/provider-config.js [--claude|--codex] [--set-default X]
// prints the provider on stdout and the explanation line on stderr.
async function main() {
  const { flag, setDefault, rest } = parseProviderArgs(process.argv.slice(2));
  if (rest.length) throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  const choice = await chooseProvider({
    flag,
    setDefault,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  });
  if (setDefault) process.stderr.write(`Default AI provider set to ${LABEL[setDefault]} (${configPath()})\n`);
  process.stderr.write(describeChoice(choice) + "\n");
  process.stdout.write(choice.provider + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
