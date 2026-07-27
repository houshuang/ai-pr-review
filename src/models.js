/**
 * Central model configuration for all Claude API calls.
 * Override the generation model per-run with REVIEW_MODEL.
 */

// Walkthrough generation, incremental patches, tip verification,
// background tip investigation, and section chat.
export const GENERATION_MODEL = process.env.REVIEW_MODEL || "claude-opus-5";

// Mechanical JSON syntax repair of malformed responses — small and fast on purpose.
export const REPAIR_MODEL = "claude-haiku-4-5-20251001";
