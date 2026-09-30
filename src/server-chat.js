import { tmpdir } from 'node:os';
import { readJsonBody, HttpError, sendError } from './server-http.js';
import { loadChatContext, chatMessages } from './chat-context.js';

export function createChatHandler({ root, runCodex, resolveAIProvider, taskConfig, anthropicClient,
  loadContext = loadChatContext, timeout = 5 * 60_000 }) {
  return async (req, res) => {
    const abort = new AbortController();
    let timer;
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', close);
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const body = await readJsonBody(req);
      const messages = chatMessages(body);
      const { provider: storedProvider, systemPrompt } = await loadContext(root, body);
      const provider = resolveAIProvider(storedProvider);
      const client = provider === 'claude' ? anthropicClient() : null;
      if (abort.signal.aborted) return;
      timer = setTimeout(() => abort.abort(), timeout);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      if (provider === 'codex') {
        const conversation = messages.map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`).join('\n\n');
        let emitted = false;
        const answer = await runCodex({
          task: 'chat', systemPrompt,
          userPrompt: `Continue this conversation. Respond only with the assistant's next answer.\n\n${conversation}`,
          cwd: tmpdir(), signal: abort.signal,
          onText: delta => { if (!abort.signal.aborted && delta) { emitted = true; res.write(delta); } },
        });
        if (!emitted) res.write(answer);
      } else {
        const settings = taskConfig('claude', 'chat');
        const stream = client.messages.stream({
          model: settings.model,
          output_config: { effort: settings.effort },
          max_tokens: 4096, system: systemPrompt, messages,
        }, { signal: abort.signal });
        for await (const event of stream) {
          if (abort.signal.aborted) break;
          if (event.type === 'content_block_delta' && event.delta?.text) res.write(event.delta.text);
        }
      }
      if (abort.signal.aborted) throw new HttpError(504, 'Chat request timed out or was disconnected');
      res.end();
    } catch (err) {
      if (abort.signal.aborted) err = new HttpError(504, 'Chat request timed out or was disconnected');
      if (!res.destroyed) sendError(res, err);
    }
    finally { clearTimeout(timer); res.off('close', close); }
  };
}
