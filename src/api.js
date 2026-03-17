import { data, isGitHubPR, fileContentCache, diffViewMode } from "./state";

export async function ghApi(method, endpoint, body) {
  const resp = await fetch("/api/gh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, endpoint, data: body }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || err.stderr || "GitHub API error");
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

export function getCommentsForFile(filePath) {
  if (!data.value?.comments?.length) return [];
  return data.value.comments.filter((c) => c.path === filePath || filePath.endsWith(c.path) || c.path.endsWith(filePath));
}

export function getCommentThreads(filePath) {
  const comments = getCommentsForFile(filePath);
  const topLevel = comments.filter((c) => !c.inReplyToId);
  const replies = comments.filter((c) => c.inReplyToId);

  return topLevel.map((c) => ({
    ...c,
    replies: replies.filter((r) => r.inReplyToId === c.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
  }));
}

export async function postComment(path, line, side, body) {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.value.meta;

  const result = await ghApi("POST", `repos/${owner}/${repo}/pulls/${number}/comments`, {
    body,
    path,
    line: String(line),
    side: side || "RIGHT",
    commit_id: "",
  });

  data.value = {
    ...data.value,
    comments: [...data.value.comments, {
      id: result.id, path, line, side: side || "RIGHT", body,
      user: "you", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      inReplyToId: null, diffHunk: "",
    }],
  };
  return result;
}

export async function postCommentRange(path, startLine, endLine, side, body) {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.value.meta;
  const commitId = await getHeadSha();

  const params = { body, path, line: String(endLine), side: side || "RIGHT", commit_id: commitId || "" };
  if (startLine && startLine !== endLine) {
    params.start_line = String(startLine);
    params.start_side = side || "RIGHT";
  }

  const result = await ghApi("POST", `repos/${owner}/${repo}/pulls/${number}/comments`, params);

  data.value = {
    ...data.value,
    comments: [...data.value.comments, {
      id: result.id, path, line: endLine,
      startLine: startLine && startLine !== endLine ? startLine : null,
      side: side || "RIGHT", body,
      user: "you", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      inReplyToId: null, diffHunk: "",
    }],
  };
  return result;
}

export async function submitReview(event, body) {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.value.meta;

  const result = await ghApi("POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, {
    body: body || "",
    event,
  });

  data.value = {
    ...data.value,
    reviews: [...(data.value.reviews || []), {
      id: result.id, user: "you",
      state: event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      body: body || "", submittedAt: new Date().toISOString(),
    }],
  };
  return result;
}

export async function refreshComments() {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.value.meta;

  try {
    const comments = await ghApi("GET", `repos/${owner}/${repo}/pulls/${number}/comments`);
    const reviews = await ghApi("GET", `repos/${owner}/${repo}/pulls/${number}/reviews`);

    data.value = {
      ...data.value,
      comments: comments.map((c) => ({
        id: c.id, path: c.path, line: c.line || c.original_line,
        startLine: c.start_line || null, side: c.side || "RIGHT",
        body: c.body, user: c.user?.login, createdAt: c.created_at,
        updatedAt: c.updated_at, inReplyToId: c.in_reply_to_id || null,
        diffHunk: c.diff_hunk,
      })),
      reviews: reviews.map((r) => ({
        id: r.id, user: r.user?.login, state: r.state,
        body: r.body, submittedAt: r.submitted_at,
      })),
    };
  } catch (err) {
    console.error("Failed to refresh comments:", err);
  }
}

let _headSha = null;

export async function getHeadSha() {
  if (_headSha) return _headSha;
  if (data.value?.meta?.headSha) {
    _headSha = data.value.meta.headSha;
    return _headSha;
  }
  if (!isGitHubPR()) return null;
  const { owner, repo, number } = data.value.meta;
  try {
    const pr = await ghApi("GET", `repos/${owner}/${repo}/pulls/${number}`);
    _headSha = pr.head?.sha;
    return _headSha;
  } catch {
    return data.value.meta.headBranch;
  }
}

export async function fetchFileContent(filePath) {
  if (fileContentCache.has(filePath)) return fileContentCache.get(filePath);
  if (!isGitHubPR()) return null;
  const { owner, repo } = data.value.meta;
  const ref = await getHeadSha();
  if (!ref) return null;
  try {
    const result = await ghApi("GET", `repos/${owner}/${repo}/contents/${filePath}`, { ref });
    const base64 = (result.content || "").replace(/\n/g, "");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    const lines = content.split("\n");
    fileContentCache.set(filePath, lines);
    return lines;
  } catch (err) {
    console.warn("Failed to fetch file content:", filePath, err);
    return null;
  }
}

export async function expandContext(filePath, direction, blockNewStart, findFileFn) {
  const file = findFileFn(filePath);
  if (!file) return;

  const fileLines = await fetchFileContent(filePath);
  if (!fileLines) return;

  const EXPAND_COUNT = 20;

  if (direction === "up") {
    const block = file.blocks.find((b) => b.newStartLine === blockNewStart) || file.blocks[0];
    if (!block || block.newStartLine <= 1) return;

    const blockIdx = file.blocks.indexOf(block);
    let minNew = 1;
    if (blockIdx > 0) {
      const prevBlock = file.blocks[blockIdx - 1];
      let lastNew = prevBlock.newStartLine;
      for (const line of prevBlock.lines) {
        if (line.newNumber) lastNew = Math.max(lastNew, line.newNumber);
      }
      minNew = lastNew + 1;
    }
    const expandFrom = Math.max(minNew, block.newStartLine - EXPAND_COUNT);
    if (expandFrom >= block.newStartLine) return;

    const oldOffset = block.oldStartLine - block.newStartLine;
    const newLines = [];
    for (let i = expandFrom; i < block.newStartLine; i++) {
      newLines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset > 0 ? i + oldOffset : null,
        newNumber: i,
      });
    }
    block.lines = [...newLines, ...block.lines];
    block.newStartLine = expandFrom;
    block.oldStartLine = expandFrom + oldOffset > 0 ? expandFrom + oldOffset : 1;
  } else if (direction === "down") {
    const lastBlock = file.blocks[file.blocks.length - 1];
    if (!lastBlock) return;
    const block = blockNewStart
      ? file.blocks.find((b) => b.newStartLine === blockNewStart) || lastBlock
      : lastBlock;

    let lastNew = block.newStartLine;
    let lastOld = block.oldStartLine;
    for (const line of block.lines) {
      if (line.newNumber) lastNew = Math.max(lastNew, line.newNumber);
      if (line.oldNumber) lastOld = Math.max(lastOld, line.oldNumber);
    }
    const blockIdx = file.blocks.indexOf(block);
    let maxNew = fileLines.length;
    if (blockIdx < file.blocks.length - 1) {
      maxNew = file.blocks[blockIdx + 1].newStartLine - 1;
    }
    const expandTo = Math.min(maxNew, lastNew + EXPAND_COUNT);
    if (expandTo <= lastNew) return;

    const oldOffset = lastOld - lastNew;
    for (let i = lastNew + 1; i <= expandTo; i++) {
      block.lines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset,
        newNumber: i,
      });
    }
  } else if (direction === "between") {
    const blockIdx = file.blocks.findIndex((b) => b.newStartLine === blockNewStart);
    if (blockIdx <= 0) return;

    const prevBlock = file.blocks[blockIdx - 1];
    const nextBlock = file.blocks[blockIdx];
    let prevEndNew = prevBlock.newStartLine;
    let prevEndOld = prevBlock.oldStartLine;
    for (const line of prevBlock.lines) {
      if (line.newNumber) prevEndNew = Math.max(prevEndNew, line.newNumber);
      if (line.oldNumber) prevEndOld = Math.max(prevEndOld, line.oldNumber);
    }

    const gapStart = prevEndNew + 1;
    const gapEnd = nextBlock.newStartLine - 1;
    if (gapStart > gapEnd) return;

    const oldOffset = prevEndOld - prevEndNew;
    for (let i = gapStart; i <= gapEnd; i++) {
      prevBlock.lines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset,
        newNumber: i,
      });
    }
    prevBlock.lines.push(...nextBlock.lines);
    file.blocks.splice(blockIdx, 1);
  }

  // Trigger re-render by updating parsedFiles reference
  // (the file object was mutated in-place, so we need to signal the change)
  return true;
}

export async function exportStaticHtml() {
  const d = data.value;
  if (!d) return;

  const params = new URLSearchParams();
  const slug = new URLSearchParams(window.location.search).get("pr") || "walkthrough-data";
  params.set("slug", slug);
  params.set("mode", diffViewMode.value || "unified");

  const resp = await fetch(`/api/export?${params}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Export failed" }));
    throw new Error(err.error || "Export failed");
  }

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
