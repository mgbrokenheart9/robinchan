/**
 * Lexicon-based sentiment score, −1..1.
 *
 * This is the phase-1 stopgap. Brief §11 puts Alpha Vantage News Sentiment in
 * phase 2; until that adapter is live, the feed still needs a number so the
 * sentiment dots on the Market page and the news component of heat score
 * have something to show. Once `ALPHAVANTAGE_API_KEY` is set, the
 * provider's score is used and this function becomes the fallback.
 */

const POSITIVE = [
  'beat',
  'beats',
  'surge',
  'surges',
  'rally',
  'rallies',
  'record',
  'upgrade',
  'upgraded',
  'outperform',
  'profit',
  'profits',
  'growth',
  'gain',
  'gains',
  'jump',
  'jumps',
  'soar',
  'soars',
  'approval',
  'approved',
  'expands',
  'partnership',
  'buyback',
  'dividend',
  'raises',
  'strong',
  'tops',
  'wins',
];

const NEGATIVE = [
  'miss',
  'misses',
  'plunge',
  'plunges',
  'slump',
  'slumps',
  'downgrade',
  'downgraded',
  'underperform',
  'loss',
  'losses',
  'lawsuit',
  'probe',
  'investigation',
  'subpoena',
  'fraud',
  'recall',
  'layoff',
  'layoffs',
  'bankruptcy',
  'halt',
  'halted',
  'fine',
  'fined',
  'warns',
  'warning',
  'cuts',
  'weak',
  'falls',
  'drops',
  'delays',
  'delisting',
];

const POS = new Set(POSITIVE);
const NEG = new Set(NEGATIVE);

export function scoreSentiment(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g);
  if (!words || words.length === 0) return 0;
  let score = 0;
  for (const word of words) {
    if (POS.has(word)) score += 1;
    else if (NEG.has(word)) score -= 1;
  }
  if (score === 0) return 0;
  // Dampen so a single keyword doesn't max out the score by itself.
  const normalized = score / Math.sqrt(Math.max(words.length, 8));
  return Math.max(-1, Math.min(1, Number(normalized.toFixed(3))));
}
