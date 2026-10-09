export async function withTaskProgress(
  label,
  work,
  { report = console.log, intervalMs = 30_000 } = {},
) {
  const started = Date.now();
  let lastActivity = null;
  let commands = 0;
  let commandsFinished = 0;
  const elapsed = () =>
    `${Math.floor((Date.now() - started) / 60_000)}m ${Math.floor((Date.now() - started) / 1000) % 60}s`;
  const activity = (event) => {
    lastActivity = Date.now();
    if (event.type === "command-started") commands++;
    if (event.type === "command-completed") commandsFinished++;
  };
  report(`${label} started.`);
  const timer = setInterval(() => {
    const evidence = commands ? ` ${commandsFinished}/${commands} source commands finished.` : "";
    const recent =
      lastActivity === null
        ? " Waiting for Codex activity."
        : ` Last Codex activity ${Math.floor((Date.now() - lastActivity) / 1000)}s ago.`;
    report(`${label} still running (${elapsed()}).${evidence}${recent}`);
  }, intervalMs);
  try {
    const result = await work(activity);
    report(`${label} completed (${elapsed()}).`);
    return result;
  } catch (error) {
    report(`${label} failed (${elapsed()}): ${error.message}`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}
