/** Central model configuration for both supported AI providers. */

// Walkthrough generation, incremental patches, tip verification,
// background tip investigation, and section chat.
export const GENERATION_MODEL = process.env.REVIEW_MODEL || "claude-opus-5-5";

// Codex uses the model configured by the CLI unless explicitly overridden.
export const CODEX_MODEL = process.env.REVIEW_CODEX_MODEL || null;

// Mechanical JSON syntax repair of malformed responses — small and fast on purpose.
export const REPAIR_MODEL = "claude-haiku-4-5-20251001";
