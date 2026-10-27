// An exhausted plan, quota or credit balance fails every request until the
// account is topped up or the window resets, so retrying it only burns time.
// Checked before the transient patterns because some of these arrive as 429s.
export const QUOTA_EXHAUSTED =
  /usage limit|hit your (?:usage )?limit|insufficient.?quota|quota exceeded|exceeded your (?:current )?quota|credit balance|out of credits|purchase more credits|billing/i;
