/**
 * MegaLLM client. It speaks the OpenAI chat-completions protocol, so this is
 * a plain `fetch` rather than an SDK. Shared by the web app (chat, order
 * parsing, portfolio reads) and the worker (heat reads).
 */

export type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function llmConfigured(): boolean {
  return Boolean(process.env.MEGALLM_API_KEY?.trim());
}

type ToolCall = { function?: { name?: string; arguments?: string } };

type CompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }> | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type CompleteOptions = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Force one function call; the result is its parsed arguments. */
  tool?: ToolSpec;
  /** Ask for a bare JSON object (used when tools aren't supported). */
  json?: boolean;
};

async function request(messages: ChatTurn[], opts: CompleteOptions): Promise<CompletionPayload> {
  const apiKey = process.env.MEGALLM_API_KEY?.trim();
  if (!apiKey) throw new LlmError('The chat model is not configured on the server.', 503);

  const baseUrl = (process.env.MEGALLM_BASE_URL?.trim() || 'https://ai.megallm.io/v1').replace(
    /\/$/,
    '',
  );
  const model = process.env.MEGALLM_MODEL?.trim() || 'openai-gpt-oss-120b';

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    // gpt-oss is a reasoning model: its hidden reasoning is billed out of
    // this same budget, so it has to be far larger than the visible reply.
    max_tokens: opts.maxTokens ?? 900,
  };
  if (opts.tool) {
    body.tools = [{ type: 'function', function: opts.tool }];
    body.tool_choice = { type: 'function', function: { name: opts.tool.name } };
  }
  if (opts.json) body.response_format = { type: 'json_object' };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
    });
  } catch (err) {
    throw new LlmError(
      err instanceof Error && err.name === 'TimeoutError'
        ? 'The chat model took too long to answer.'
        : 'The chat model could not be reached.',
    );
  }

  const payload = (await response.json().catch(() => ({}))) as CompletionPayload;
  if (!response.ok) {
    console.error(`[llm] MegaLLM ${response.status}: ${payload.error?.message ?? 'no body'}`);
    throw new LlmError(
      response.status === 401
        ? 'The chat model rejected the server API key.'
        : `The chat model returned an error (${response.status}).`,
      response.status === 400 ? 400 : 502,
    );
  }
  return payload;
}

function textOf(payload: CompletionPayload): string {
  const content = payload.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : (content ?? '');
}

export async function complete(messages: ChatTurn[], opts: CompleteOptions = {}): Promise<string> {
  const text = textOf(await request(messages, opts));
  if (!text.trim()) throw new LlmError('The chat model returned an empty reply.');
  return text;
}

/**
 * Structured extraction: function calling first (temperature 0, brief §12),
 * falling back to JSON mode if the provider rejects `tools`, then to reading
 * a JSON object out of plain text. Returns the parsed object — validating it
 * is the caller's job.
 */
export async function completeStructured(
  messages: ChatTurn[],
  tool: ToolSpec,
  opts: Omit<CompleteOptions, 'tool' | 'json'> = {},
): Promise<Record<string, unknown>> {
  const base = { ...opts, temperature: 0 };
  try {
    const payload = await request(messages, { ...base, tool });
    const call = payload.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function?.name === tool.name,
    );
    if (call?.function?.arguments) return parseObject(call.function.arguments);
    const text = textOf(payload);
    if (text.trim()) return parseObject(text);
  } catch (err) {
    if (!(err instanceof LlmError) || err.status !== 400) throw err;
    // 400 = this model/provider doesn't take `tools`; retry in JSON mode.
  }
  const schemaHint = `Reply with only a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(tool.parameters)}`;
  const text = await complete(
    [...messages, { role: 'system', content: schemaHint }],
    { ...base, json: true },
  );
  return parseObject(text);
}

function parseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('The model did not return a JSON object.');
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new LlmError('The model returned malformed JSON.');
  }
}
