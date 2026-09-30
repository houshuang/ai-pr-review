/** Model and reasoning settings are explicit so CLI preferences cannot change a review. */
const TASKS = new Set(["generation", "patch", "verification", "investigation", "chat", "repair"]);
const CODEX_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function getTaskConfig(provider, task = "generation", env = process.env) {
  if (provider !== "codex" && provider !== "claude") throw new Error(`Unsupported AI provider: ${provider}`);
  if (!TASKS.has(task)) throw new Error(`Unsupported AI task: ${task}`);
  const prefix = `REVIEW_${provider.toUpperCase()}`;
  const stage = `${prefix}_${task.toUpperCase()}`;
  const defaultModel = provider === "codex" ? "gpt-6.1-sol"
    : task === "repair" ? "claude-haiku-4-5-20251001" : "claude-opus-5-5";
  const defaultEffort = task === "chat" ? "low" : task === "investigation" ? "high" : "medium";
  const model = env[`${stage}_MODEL`] || env[`${prefix}_MODEL`] ||
    (provider === "claude" && task !== "repair" ? env.REVIEW_MODEL : null) || defaultModel;
  const effort = env[`${stage}_EFFORT`] || env[`${prefix}_EFFORT`] || defaultEffort;
  if (!(provider === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS).has(effort)) {
    throw new Error(`Invalid ${stage}_EFFORT: ${effort}`);
  }
  if (provider === "codex" && model === "gpt-6.1-sol" && ["none", "minimal"].includes(effort)) {
    throw new Error(`${model} does not support reasoning effort "${effort}"; use low or higher`);
  }
  return { model, effort };
}

// Compatibility for consumers that have not yet supplied a task.
export const GENERATION_MODEL = getTaskConfig("claude").model;
export const CODEX_MODEL = getTaskConfig("codex").model;
export const REPAIR_MODEL = getTaskConfig("claude", "repair").model;
