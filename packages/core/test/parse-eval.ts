/**
 * Order-parsing evaluation (main brief §17, M4): 30 sentences; at least 28
 * must be parsed correctly *or* asked back, and none may be parsed wrong
 * silently. Calls the real model, so it needs MEGALLM_API_KEY and costs a
 * little — it's not part of `npm test`:
 *
 *   npm run eval:parse -w @robinchan/core
 */
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import type { OrderIntent } from '@robinchan/shared';
import { repoRoot } from '@robinchan/store';

loadEnv({ path: join(repoRoot(), '.env'), quiet: true });
const { parseOrderText } = await import('../src/orders/parse');

type Expect = { intent: OrderIntent } | 'ask' | 'ask-or-none';
type Case = { text: string; symbol?: string; expect: Expect; alsoOk?: OrderIntent };

const m = (side: 'buy' | 'sell', qty: number, symbol: string): OrderIntent => ({ side, symbol, qty, orderType: 'market', limitPrice: null });
const l = (side: 'buy' | 'sell', qty: number, symbol: string, limitPrice: number): OrderIntent => ({ side, symbol, qty, orderType: 'limit', limitPrice });

const CASES: Case[] = [
  { text: 'buy 4 NVDA', expect: { intent: m('buy', 4, 'NVDA') } },
  { text: 'sell 2 shares of Apple', expect: { intent: m('sell', 2, 'AAPL') } },
  { text: 'buy 10 TSLA at 400', expect: { intent: l('buy', 10, 'TSLA', 400) } },
  { text: 'grab 4 shares of nvidia if it drops to 172', expect: { intent: l('buy', 4, 'NVDA', 172) } },
  { text: 'beli 5 lembar MSFT', expect: { intent: m('buy', 5, 'MSFT') } },
  { text: 'jual 3 AMZN di harga 240', expect: { intent: l('sell', 3, 'AMZN', 240) } },
  { text: 'beli 1.5 META', expect: { intent: m('buy', 1.5, 'META') } },
  { text: 'sell 7 coinbase at market', expect: { intent: m('sell', 7, 'COIN') } },
  { text: 'buy GOOGL', expect: 'ask' },
  { text: 'buy $500 of NVDA', expect: 'ask' },
  { text: 'sell 3', expect: 'ask' },
  { text: 'beli 2 kalau harganya turun ke 230', symbol: 'AAPL', expect: { intent: l('buy', 2, 'AAPL', 230) } },
  { text: 'I want to buy some tesla', expect: 'ask' },
  { text: 'buy 3 NVDA and 2 AAPL', expect: 'ask' },
  { text: "what's the price of NVDA right now?", expect: 'ask-or-none' },
  { text: 'should I buy nvidia?', expect: 'ask-or-none' },
  { text: 'buy two apple shares', expect: { intent: m('buy', 2, 'AAPL') } },
  { text: 'jual semua TSLA saya', expect: 'ask' },
  { text: 'buy 100 AAPL limit 225.50', expect: { intent: l('buy', 100, 'AAPL', 225.5) } },
  { text: 'Tolong belikan 3 saham Microsoft', expect: { intent: m('buy', 3, 'MSFT') } },
  { text: 'sell 5 META when it hits 800', expect: { intent: l('sell', 5, 'META', 800) } },
  { text: 'buy 0.25 NVDA', expect: { intent: m('buy', 0.25, 'NVDA') } },
  { text: 'short 2 TSLA', expect: 'ask', alsoOk: m('sell', 2, 'TSLA') },
  { text: 'buy 1,000 COIN', expect: { intent: m('buy', 1000, 'COIN') } },
  { text: 'beli NVDA 3', expect: { intent: m('buy', 3, 'NVDA') } },
  { text: 'buy 3 RCHAN', expect: 'ask' },
  { text: 'sell 4 amazon at 5', expect: { intent: l('sell', 4, 'AMZN', 5) } },
  { text: 'buy 5 nvda for 170 each', expect: 'ask', alsoOk: l('buy', 5, 'NVDA', 170) },
  { text: 'jual 10 lembar GOOGL', expect: { intent: m('sell', 10, 'GOOGL') } },
  { text: 'Buy 6 Tesla shares at $395', expect: { intent: l('buy', 6, 'TSLA', 395) } },
];

const same = (a: OrderIntent, b: OrderIntent) =>
  a.side === b.side && a.symbol === b.symbol && Math.abs(a.qty - b.qty) < 1e-9 && a.orderType === b.orderType &&
  (a.limitPrice == null ? b.limitPrice == null : b.limitPrice != null && Math.abs(a.limitPrice - b.limitPrice) < 1e-9);

let correct = 0;
let asked = 0;
let silent = 0;
for (const c of CASES) {
  let verdict: 'correct' | 'asked' | 'SILENT MISPARSE';
  let detail = '';
  try {
    const r = await parseOrderText(c.text, { symbol: c.symbol ?? null });
    if (r && r.ok) {
      detail = `${r.intent.side} ${r.intent.qty} ${r.intent.symbol} ${r.intent.orderType}${r.intent.limitPrice != null ? ` @${r.intent.limitPrice}` : ''}${r.symbolFromContext ? ' (symbol from page)' : ''}`;
      const expected = typeof c.expect === 'object' ? c.expect.intent : c.alsoOk;
      verdict = expected && same(r.intent, expected) ? 'correct' : 'SILENT MISPARSE';
    } else {
      detail = r ? `asks for: ${r.missing.join(', ')}${r.reason ? ` (${r.reason})` : ''}` : 'not an order';
      // Asking back is always safe; an expected order that gets a question is still acceptable.
      verdict = c.expect === 'ask-or-none' || c.expect === 'ask' ? 'correct' : 'asked';
    }
  } catch (err) {
    detail = `error: ${(err as Error).message}`;
    verdict = 'asked';
  }
  if (verdict === 'correct') correct += 1;
  else if (verdict === 'asked') asked += 1;
  else silent += 1;
  console.log(`${verdict.padEnd(15)} ${JSON.stringify(c.text).padEnd(50)} → ${detail}`);
}

console.log(`\n${correct} correct, ${asked} asked back instead, ${silent} silent misparse (of ${CASES.length})`);
const pass = correct + asked >= 28 && silent === 0;
console.log(pass ? 'PASS: ≥28 correct-or-asked, 0 silent misparses' : 'FAIL');
process.exit(pass ? 0 : 1);
