import 'server-only';

/**
 * MegaLLM client — the implementation lives in `@robinchan/core` so the
 * worker (heat reads) and the web app (chat, order parsing, portfolio
 * reads) share one. This module keeps the `server-only` guard for the web
 * bundle.
 */
export { complete, LlmError, llmConfigured, type ChatTurn } from '@robinchan/core';
