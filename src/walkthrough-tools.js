import { readSource } from "./repository-explanation.js";
import { runCommand } from "./server-http.js";

const MAX_ROUNDS = 30;
const MAX_MATCHES = 80;

export const CODE_TOOLS = [
  {
    name: "read_source",
    description: "Read a repository file around a line at the reviewed head or the diff base. Returns about 58 numbered lines; set full to read the whole file.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Repository-relative path" },
        line: { type: "integer", minimum: 1 },
        revision: { type: "string", enum: ["head", "base"] },
        full: { type: "boolean" },
      },
    },
  },
  {
    name: "search_code",
    description: "Search tracked files at the reviewed head or the diff base with a git grep extended regular expression. Returns path:line:text matches.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Optional repository-relative directory or file to limit the search" },
        revision: { type: "string", enum: ["head", "base"] },
      },
    },
  },
];

export async function runCodeTool(context, name, input = {}) {
  const revision = input.revision || "head";
  if (name === "read_source") {
    const source = await readSource(context, { path: input.path, line: input.line || 1, revision, full: Boolean(input.full) });
    return `${source.path} (${revision}, lines ${source.start}-${source.end})\n${source.text}`;
  }
  if (name === "search_code") {
    const snapshot = context[revision];
    if (!snapshot) throw new Error("Base revision is unavailable");
    if (typeof input.pattern !== "string" || !input.pattern || input.pattern.length > 500) throw new Error("Invalid search pattern");
    if (input.path !== undefined && (typeof input.path !== "string" || input.path.startsWith("/") || input.path.split("/").includes(".."))) throw new Error("Invalid search path");
    let output;
    try {
      output = await runCommand("git", ["grep", "-n", "-I", "-E", "-e", input.pattern, "--", input.path || "."], { cwd: snapshot.path });
    } catch (error) {
      if (error.code === 1) return "No matches.";
      throw new Error(error.stderr?.trim() || error.message);
    }
    const lines = output.split("\n").filter(Boolean);
    const shown = lines.slice(0, MAX_MATCHES).map((line) => line.slice(0, 300));
    return lines.length > MAX_MATCHES ? `${shown.join("\n")}\n… ${lines.length - MAX_MATCHES} more matches; narrow the pattern or path.` : shown.join("\n");
  }
  throw new Error(`Unknown tool: ${name}`);
}

// Without breakpoints every round re-bills the whole conversation, so cache the opening prompt and the two latest user turns.
function markCacheBreakpoints(messages) {
  const users = [];
  messages.forEach((message, index) => {
    if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
    if (message.role === "user") users.push(index);
  });
  for (const index of [0, ...users.slice(-2)]) {
    const content = messages[index].content;
    if (Array.isArray(content) && content.length) content[content.length - 1].cache_control = { type: "ephemeral" };
  }
}

/**
 * Runs a Messages API request in which the model may look up repository code
 * before answering. `send` takes request params and resolves to the final
 * message, so callers keep their own streaming and error reporting.
 */
export async function withCodeTools(send, params, context, { log = () => {}, maxRounds = MAX_ROUNDS } = {}) {
  const messages = params.messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
  }));
  const usage = { input: 0, output: 0, cacheRead: 0 };
  for (let round = 0; ; round++) {
    markCacheBreakpoints(messages);
    const response = await send({
      ...params,
      messages,
      tools: CODE_TOOLS,
      ...(round >= maxRounds ? { tool_choice: { type: "none" } } : {}),
    });
    usage.input += response.usage?.input_tokens || 0;
    usage.output += response.usage?.output_tokens || 0;
    usage.cacheRead += response.usage?.cache_read_input_tokens || 0;
    const calls = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !calls.length) return { response, usage, rounds: round };
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const call of calls) {
      try {
        results.push({ type: "tool_result", tool_use_id: call.id, content: await runCodeTool(context, call.name, call.input) });
      } catch (error) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: error.message, is_error: true });
      }
    }
    log(`Looked up ${calls.map((call) => `${call.input?.path || call.input?.pattern || call.name}`).join(", ")}`);
    messages.push({ role: "user", content: results });
  }
}
