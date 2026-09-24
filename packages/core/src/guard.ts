/**
 * "Describes, doesn't advise" (Heat §6, Portfolio §7).
 *
 * Every generated read passes through this before it's stored or shown. A
 * prompt alone isn't a guarantee — models drift — so a read that slips into
 * advice is rejected outright and replaced by the deterministic template,
 * never lightly edited into shape.
 *
 * The patterns target advisory constructions ("time to buy", "you should
 * diversify", "sebaiknya jual"), not trading vocabulary on its own: "selling
 * pressure" or "buy volume" describe the market and stay allowed.
 */
const ADVICE_PATTERNS: RegExp[] = [
  // English
  /\b(you|u|we|i)\s+(should|shouldn't|should not|must|need to|ought to|might want to|may want to)\b/i,
  /\b(i|we)\s+(recommend|suggest|advise|would buy|would sell)\b/i,
  /\b(recommend(ed|ing|s|ation)?|advis(e|ed|ing|able))\b/i,
  /\b(time|moment|chance)\s+to\s+(buy|sell|get in|get out|enter|exit|load up|take profits?)\b/i,
  /\b(buy|sell)\s+(now|today|the dip|the rip)\b/i,
  /\b(good|great|solid|strong|attractive)\s+(buy|entry|entry point|opportunity|time to)\b/i,
  /\bconsider\s+(buying|selling|adding|trimming|reducing|increasing|diversifying|rebalancing)\b/i,
  /\b(diversif(y|ying|ication)|rebalanc(e|ing))\b/i,
  /\b(take|lock in)\s+profits?\b/i,
  /\bcut\s+(your\s+)?loss(es)?\b/i,
  /\b(go|going)\s+(long|short)\b/i,
  /\b(undervalued|overvalued|a bargain|worth buying|worth selling)\b/i,
  // Indonesian
  /\b(sebaiknya|seharusnya|disarankan|menyarankan|saran(ku|nya)?|rekomendasi|merekomendasikan|anjuran|dianjurkan)\b/i,
  /\b(saatnya|waktunya|momen(nya)?|kesempatan)\s+(untuk\s+)?(beli|membeli|jual|menjual|masuk|keluar|serok|borong)\b/i,
  /\b(beli|jual|serok|borong)\s+(sekarang|aja|saja|dulu)\b/i,
  /\b(layak|patut|wajib|perlu|harus)\s+(di)?(beli|jual|dikoleksi|dipegang|dilepas)\b/i,
  /\b(kamu|anda|lo|lu|kalian)\s+(harus|perlu|wajib|mesti|bisa pertimbangkan)\b/i,
  /\b(diversifikasi|rebalancing|ambil untung|take profit|cut loss|averaging down)\b/i,
  /\b(murah banget|kemurahan|kemahalan|undervalue|overvalue)\b/i,
];

export function soundsLikeAdvice(text: string): boolean {
  return ADVICE_PATTERNS.some((re) => re.test(text));
}

/**
 * Cleans a generated read down to one short paragraph of plain spoken text,
 * then returns null if it's empty, too short to say anything, or advice.
 */
export function acceptRead(raw: string, maxChars = 480): string | null {
  const text = raw
    .replace(/\[(?:happy|focused|alert|relaxed)\]/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~]|\\/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 24) return null;
  if (soundsLikeAdvice(text)) return null;
  if (text.length <= maxChars) return text;
  // Cut at the last sentence end that fits rather than mid-word.
  const cut = text.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Fences third-party text for a prompt: one bounded line, no way to close the fence. */
export function fenceText(text: string, max: number): string {
  return text
    .replace(/<\/?[a-z_]+>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
