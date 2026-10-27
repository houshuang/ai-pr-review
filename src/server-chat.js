import { tmpdir } from 'node:os';
import { readJsonBody, HttpError, sendError } from './server-http.js';
import { loadChatContext, chatMessages, buildChatContext } from './chat-context.js';

export function createChatHandler({ root, runAgent, resolveAIProvider, taskConfig, anthropicClient,
  loadContext = loadChatContext, repository = null, timeout = 5 * 60_000 }) {
  return async (req, res) => {
    const abort = new AbortController();
    let timer, release = null;
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', close);
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const body = await readJsonBody(req);
      const messages = chatMessages(body);
      const { provider: storedProvider, systemPrompt: diffOnlyPrompt, review } = await loadContext(root, body);
      const provider = resolveAIProvider(storedProvider);
      let systemPrompt = diffOnlyPrompt, cwd = tmpdir(), allowShell = false;
      // Either CLI agent can read the reviewed head; without a pinned revision the chat stays on the section's hunks,
      // which Claude answers through the API.
      if (repository && review?.meta?.headSha) {
        try {
          const context = await repository(review);
          cwd = context.head.path; release = context.cleanup; allowShell = true;
          systemPrompt = buildChatContext(review, body.sectionId, undefined, { repository: true }).systemPrompt;
        } catch { /* The snapshot is optional; the diff-only prompt says what is missing. */ }
      }
      const useAgent = provider === 'codex' || allowShell;
      const client = useAgent ? null : anthropicClient();
      if (abort.signal.aborted) return;
      timer = setTimeout(() => abort.abort(), timeout);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      let emitted = false;
      const answerWithAgent = async (agentProvider, options = {}) => {
        const conversation = messages.map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`).join('\n\n');
        const answer = await runAgent({
          provider: agentProvider, task: 'chat', systemPrompt,
          userPrompt: `Continue this conversation. Respond only with the assistant's next answer.\n\n${conversation}`,
          cwd, allowShell, signal: abort.signal, ...options,
          onText: delta => { if (!abort.signal.aborted && delta) { emitted = true; res.write(delta); } },
        });
        if (!emitted) res.write(answer);
      };
      if (useAgent) await answerWithAgent(provider);
      else {
        const settings = taskConfig('claude', 'chat');
        try {
          const stream = client.messages.stream({
            model: settings.model,
            output_config: { effort: settings.effort },
            max_tokens: 4096, system: systemPrompt, messages,
          }, { signal: abort.signal });
          for await (const event of stream) {
            if (abort.signal.aborted) break;
            if (event.type === 'content_block_delta' && event.delta?.text) { emitted = true; res.write(event.delta.text); }
          }
        } catch (err) {
          // A failed API request that has not answered yet is retried through Codex.
          if (emitted || abort.signal.aborted) throw err;
          try { await answerWithAgent('codex', { fallback: false }); } catch { throw err; }
        }
      }
      if (abort.signal.aborted) throw new HttpError(504, 'Chat request timed out or was disconnected');
      res.end();
    } catch (err) {
      if (abort.signal.aborted) err = new HttpError(504, 'Chat request timed out or was disconnected');
      if (!res.destroyed) sendError(res, err);
    }
    finally { clearTimeout(timer); res.off('close', close); await release?.(); }
  };
}
