import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const names = {
  "Repository research": "Repository research",
  "Implementation research": "Implementation",
  "Invariant and test research": "Tests & invariants",
  "Writing walkthrough": "Write walkthrough",
  "Updating walkthrough": "Update walkthrough",
  "Repairing walkthrough": "Repair references",
  "Codex task": "Codex",
};
const stages = Object.keys(names)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const progress = new RegExp(
  `^(${stages}) (started\\.|still running \\((\\d+)m (\\d+)s\\)\\.(.*)|completed \\((\\d+)m (\\d+)s\\)\\.|failed \\((\\d+)m (\\d+)s\\): (.*))$`,
);
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function parseProgress(line) {
  const match = line.match(progress);
  if (!match) {
    return null;
  }
  const status =
    match[2].startsWith("started") || match[2].startsWith("still")
      ? "running"
      : match[2].startsWith("completed")
        ? "complete"
        : "failed";
  const minutes = Number(match[3] || match[6] || match[8] || 0);
  const seconds = Number(match[4] || match[7] || match[9] || 0);
  const details = match[5] || "";
  const commands = details.match(/(\d+)\/(\d+) source commands finished/);
  const idle = details.match(/Last Codex activity (\d+)s ago/);
  return {
    label: match[1],
    status,
    elapsedMs: (minutes * 60 + seconds) * 1000,
    commands: commands ? Number(commands[1]) : null,
    idleMs: idle ? Number(idle[1]) * 1000 : null,
    error: match[10] || null,
  };
}

export function reviewHeading(target) {
  const match = target?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  return match ? `Review  ${match[1]}/${match[2]} #${match[3]}` : "Code review";
}
function clock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function safe(text) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function createTerminalProgress({
  output = process.stdout,
  live = Boolean(output.isTTY && process.env.TERM !== "dumb" && !process.env.CI),
  color = live && !Object.hasOwn(process.env, "NO_COLOR"),
  now = Date.now,
} = {}) {
  const rows = new Map();
  let drawn = 0,
    frame = 0;
  const clear = () => {
    if (drawn) {
      output.write(`\x1b[${drawn}A\x1b[0J`);
      drawn = 0;
    }
  };
  const paint = (text, code) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const draw = () => {
    if (!live || !rows.size) {
      return;
    }
    clear();
    const width = Math.max(10, (output.columns || 80) - 1);
    const lines = [...rows.values()].map((row) => {
      const elapsed = row.elapsedMs + (row.status === "running" ? now() - row.updatedAt : 0);
      const icon =
        row.status === "complete"
          ? "✓"
          : row.status === "failed"
            ? "✕"
            : row.status === "stopped"
              ? "–"
              : frames[frame % frames.length];
      const stats =
        row.commands !== null ? `${row.commands} source commands` : "waiting for response";
      const detail =
        row.status === "failed"
          ? row.error
          : row.status === "complete"
            ? "done"
            : row.status === "stopped"
              ? "stopped"
              : stats;
      const plain = safe(
        `  ${icon} ${names[row.label].padEnd(19)} ${clock(elapsed).padStart(5)}  ${detail}`,
      );
      return paint(
        [...plain].slice(0, width).join(""),
        row.status === "failed" ? "31" : row.status === "complete" ? "32" : "36",
      );
    });
    output.write(lines.join("\n") + "\n");
    drawn = lines.length;
    frame++;
  };
  const timer = live ? setInterval(draw, 100) : null;
  timer?.unref();
  return {
    line(line) {
      if (!live) {
        output.write(line + "\n");
        return;
      }
      const event = parseProgress(line);
      if (event) {
        const prior = rows.get(event.label);
        rows.set(event.label, {
          ...event,
          commands: event.commands ?? prior?.commands ?? null,
          updatedAt: now(),
        });
        draw();
        return;
      }
      if (
        /^Sending to Codex CLI|^Researching implementation and invariants concurrently|^Researching repository in one read-only pass/.test(
          line,
        )
      ) {
        return;
      }
      if (line.startsWith("Researching algorithms,")) {
        line = "Preparing repository evidence…";
      }
      if (line.startsWith("Fetching diff, comments,")) {
        line = "Fetching changes and review context…";
      }
      clear();
      if (line.trim()) {
        output.write(safe(line) + "\n");
      }
      draw();
    },
    close() {
      clearInterval(timer);
      for (const row of rows.values()) {
        if (row.status === "running") {
          row.elapsedMs += now() - row.updatedAt;
          row.status = "stopped";
        }
      }
      if (live) {
        draw();
      }
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const log = args[args.indexOf("--log") + 1];
  if (!args.includes("--log") || !log) {
    throw new Error("Progress renderer requires --log");
  }
  const renderer = createTerminalProgress();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => {
    renderer.close();
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for await (const line of input) {
      appendFileSync(log, line + "\n");
      renderer.line(line);
    }
  } finally {
    renderer.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Progress display failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
