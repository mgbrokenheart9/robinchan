import type {
  CheckContract,
  CheckFinding,
  CheckKnown,
  CheckMarket,
  CheckSimulation,
  CheckSupply,
  CheckVerdict,
  TokenCheck,
} from '@robinchan/shared';
import { KNOWN_TOKENS, STOCK_TOKENS, formatUsdCompact, shortAddress, stockTokenAt } from '@robinchan/shared';

/**
 * Token Check's reading of the facts: which findings they add up to, the
 * verdict on top, and Robinchan's line. Pure, so every rule is testable
 * without a chain. The wording describes what was found; it never says
 * what to do about it.
 */

export type CheckFacts = {
  address: string;
  /** Code is deployed at the address. */
  isContract: boolean;
  token: TokenCheck['token'];
  contract: CheckContract | null;
  market: CheckMarket | null;
  /** DexScreener didn't answer — not the same as "no pools". */
  marketUnavailable: boolean;
  simulation: CheckSimulation;
  supply: CheckSupply | null;
  now: number;
};

export type Judgement = Pick<TokenCheck, 'verdict' | 'headline' | 'findings' | 'known' | 'impersonates'>;

export function knownToken(address: string): CheckKnown | null {
  const stock = stockTokenAt(address);
  if (stock) return { kind: 'stock', symbol: stock.symbol, name: stock.name };
  return KNOWN_TOKENS.find((k) => k.address.toLowerCase() === address.toLowerCase())?.known ?? null;
}

const tickerOf = (symbol: string) => symbol.trim().replace(/^\$/, '').toUpperCase();

/** First word of a company name, for spotting it inside another token's name ("Tesla", "NVIDIA", "Amazon"). */
const brandOf = (name: string) => name.toLowerCase().split(/[\s,.]+/)[0] ?? '';

/**
 * Whether a token dresses up as one whose issuer is known. `name`: it also
 * borrows Robinhood's (or Robinchan's) name, or is a stablecoin or WETH
 * lookalike — impersonation. `ticker`: only the ticker is shared, as
 * stock-themed memecoins do.
 */
export function impersonationOf(address: string, token: { name: string; symbol: string }): TokenCheck['impersonates'] {
  if (knownToken(address)) return null;
  const ticker = tickerOf(token.symbol);
  const name = token.name.toLowerCase();

  for (const k of KNOWN_TOKENS) {
    const byName = k.known.kind === 'rchan' && name.includes('robinchan');
    if (ticker === k.known.symbol || byName) return { symbol: k.known.symbol, name: k.known.name, address: k.address, by: 'name' };
  }

  const stock = STOCK_TOKENS.find((s) => s.symbol === ticker);
  if (stock) {
    const claims = name.includes('robinhood') || (name.includes(brandOf(stock.name)) && /\b(token|stock|share)s?\b/.test(name));
    return { symbol: stock.symbol, name: stock.name, address: stock.address, by: claims ? 'name' : 'ticker' };
  }
  const byBrand = STOCK_TOKENS.find((s) => name.includes('robinhood') && name.includes(brandOf(s.name)));
  return byBrand ? { symbol: byBrand.symbol, name: byBrand.name, address: byBrand.address, by: 'name' } : null;
}

const pct = (v: number) => `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}%`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function ago(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

const ORDER = { danger: 0, warn: 1, info: 2, good: 3 } as const;

export function judgeToken(f: CheckFacts): Judgement {
  const findings: CheckFinding[] = [];
  const add = (id: string, severity: CheckFinding['severity'], title: string, detail: string) => findings.push({ id, severity, title, detail });

  if (!f.isContract || !f.token) {
    return {
      verdict: 'unknown',
      known: null,
      impersonates: null,
      findings: [],
      headline: !f.isContract
        ? "That's not a token contract. It looks like a wallet, or nothing is deployed there."
        : "There's a contract here, but it doesn't answer like a token, so I can't read it.",
    };
  }

  const token = f.token;
  const known = knownToken(f.address);
  const impersonates = impersonationOf(f.address, token);
  const c = f.contract;
  const sim = f.simulation;
  const m = f.market;

  /* ---- who issued it ---- */
  if (known?.kind === 'stock') {
    add('official', 'good', 'Official Robinhood stock token', `Issued by Robinhood for ${known.name} (${known.symbol}). Its price is meant to track ${known.symbol} shares.`);
    if (c && (c.capabilities.length || c.upgradeable)) {
      add('issuer-controls', 'info', 'Issuer controls', 'Like any regulated stock token, the issuer can mint, burn, pause or upgrade it. That is expected here.');
    }
  } else if (known?.kind === 'rchan') {
    add('official', 'good', 'This is $RCHAN', "Robinchan's own token, launched on the Pons launchpad.");
  } else if (known?.kind === 'stable') {
    add('official', 'good', 'USDG, the Global Dollar', "Paxos' regulated stablecoin, the main dollar on Robinhood Chain.");
  } else if (known?.kind === 'wrapped') {
    add('official', 'good', 'Wrapped Ether', 'ETH as a token: the quote side of most pools on the chain.');
  }

  if (impersonates) {
    const real = shortAddress(impersonates.address);
    const isStock = STOCK_TOKENS.some((s) => s.symbol === impersonates.symbol);
    if (impersonates.by === 'name') {
      add(
        'impersonation',
        'danger',
        `Impersonates ${isStock ? `the official ${impersonates.symbol} token` : impersonates.symbol}`,
        `It's called "${token.name}", but the real ${impersonates.name}${isStock ? ' stock token' : ''} is ${real}. This contract isn't it.`,
      );
    } else {
      add(
        'ticker',
        'warn',
        `Not the official ${impersonates.symbol}`,
        `It trades as ${impersonates.symbol}, but Robinhood's ${impersonates.name} stock token is ${real}. Stock-themed memecoins borrow tickers all the time.`,
      );
    }
  } else if (!known && token.name.toLowerCase().includes('robinhood')) {
    add('robinhood-name', 'warn', "Uses Robinhood's name", "Robinhood doesn't issue memecoins: the name is borrowed.");
  }

  /* ---- the sell test ---- */
  if (sim.status === 'skipped') {
    add('sim-skipped', 'info', 'Sell test not run', sim.note);
  } else if (sim.buy && !sim.buy.ok) {
    add('buy-blocked', known ? 'info' : 'danger', 'Buying looks blocked', `A simulated transfer out of its ${sim.via ?? ''} pool failed${sim.buy.error ? ` (${sim.buy.error})` : ''}. Trading may be switched off or restricted.`);
  } else if (sim.sell && !sim.sell.ok) {
    add('sell-blocked', known ? 'info' : 'danger', 'Selling looks blocked', `A simulated sale back into its ${sim.via ?? ''} pool failed${sim.sell.error ? ` (${sim.sell.error})` : ''}. That's the classic honeypot pattern.`);
  } else {
    const legs: Array<['buy' | 'sell', number]> = [
      ['buy', sim.buy?.taxPct ?? 0],
      ['sell', sim.sell?.taxPct ?? 0],
    ];
    let taxed = false;
    for (const [leg, tax] of legs) {
      if (tax < 0.5) continue;
      taxed = true;
      const severity = known ? 'info' : tax >= 20 ? 'danger' : tax >= 5 ? 'warn' : 'info';
      add(
        `${leg}-tax`,
        severity,
        `${pct(tax)} ${leg} tax`,
        leg === 'sell'
          ? `Only ${pct(100 - tax)} of a simulated sale reached the pool; the rest was taken on the way.`
          : `A simulated buy delivered ${pct(100 - tax)} of the tokens; the rest was taken on the way.`,
      );
    }
    if (!taxed) {
      add('no-tax', 'good', 'Buys and sells go through, no tax', `Simulated on a copy of the chain through its ${sim.via ?? ''} pool: the tokens arrived in full both ways.`);
    }
  }

  /* ---- the contract ---- */
  if (c && !known) {
    const caps = new Set(c.capabilities);
    const admin = c.ownerState === 'active' ? 'The owner' : caps.has('roles') ? 'An admin' : null;
    if (c.upgradeable) {
      add('upgradeable', 'warn', 'Upgradeable contract', 'Its code sits behind a proxy, so whoever controls it can change how the token works.');
    }
    if (c.ownerState === 'renounced') {
      add('renounced', 'good', 'Ownership renounced', 'The owner is set to the zero address, so nobody can call owner-only functions.');
    } else if (c.ownerState === 'none' && !caps.has('roles')) {
      add('no-owner', 'good', 'No owner', 'The contract has no owner function: there is no admin to change it.');
    }
    if (caps.has('roles')) {
      add('roles', 'info', 'Role-based permissions', "Admin powers are handed out as roles (AccessControl) rather than to one owner. Who holds them can't be read without an indexer.");
    }
    if (admin) {
      if (caps.has('mint')) add('mint', 'warn', `${admin} can mint more`, 'New supply can be created at will, diluting every holder.');
      if (caps.has('blacklist')) add('blacklist', 'warn', `${admin} can block wallets`, 'The contract keeps a blacklist that can stop an address from moving its tokens.');
      if (caps.has('pause')) add('pause', 'warn', `${admin} can pause transfers`, 'Every transfer, sells included, can be switched off.');
      if (caps.has('fees')) add('fees', 'warn', `${admin} can change the tax`, 'Buy and sell fees can be raised at any time.');
      if (caps.has('trading')) add('trading', 'info', `${admin} controls trading`, 'Trading has an on/off switch.');
      if (caps.has('limits')) add('limits', 'info', 'Transaction or wallet limits', 'How much one wallet can hold or move can be capped.');
      if (!['mint', 'blacklist', 'pause', 'fees', 'trading', 'limits'].some((k) => caps.has(k as never)) && c.owner) {
        add('owner', 'info', 'Has an owner', `Owner ${shortAddress(c.owner)}. No mint, blacklist, pause or fee switch turned up in the code.`);
      }
    }
  }

  /* ---- the market ---- */
  if (f.marketUnavailable) {
    add('market-unavailable', 'info', 'Market data unavailable', "DexScreener didn't answer, so liquidity and age weren't checked this time.");
  } else if (!m || m.pools.length === 0) {
    if (!known) add('no-pools', 'warn', 'No trading pools found', 'DexScreener lists no pool for it on Robinhood Chain: there is no market to sell into.');
  } else {
    const liq = m.liquidityUsd;
    if (liq < 1_000) add('thin-liquidity', known ? 'info' : 'warn', `Almost no liquidity (${formatUsdCompact(liq)})`, 'Even a tiny sale moves the price a lot.');
    else if (liq < 10_000) add('thin-liquidity', known ? 'info' : 'warn', `Thin liquidity (${formatUsdCompact(liq)})`, 'A modest sale moves the price a lot.');
    else if (liq >= 100_000) add('deep-liquidity', 'good', `Deep liquidity (${formatUsdCompact(liq)})`, `Across ${m.pools.length} pool${m.pools.length === 1 ? '' : 's'} on Robinhood Chain.`);

    if (m.firstPoolAt && !known) {
      const age = f.now - Date.parse(m.firstPoolAt);
      if (age < 86_400_000) add('new', 'warn', 'Brand new', `Its first pool opened ${ago(age)}.`);
      else if (age < 7 * 86_400_000) add('young', 'info', 'Less than a week old', `Its first pool opened ${ago(age)}.`);
    }
    if (!known && m.buys24h >= 20 && m.sells24h === 0) {
      add('no-sellers', 'danger', 'Nobody has sold in 24 hours', `${m.buys24h} buys and not one sell: holders may not be able to sell.`);
    }
  }

  /* ---- the supply ---- */
  const s = f.supply;
  if (s && !known) {
    if (s.ownerPct != null && s.ownerPct >= 50) add('owner-supply', 'danger', `The owner holds ${pct(s.ownerPct)} of supply`, 'One wallet can dump most of the supply at once.');
    else if (s.ownerPct != null && s.ownerPct >= 15) add('owner-supply', 'warn', `The owner holds ${pct(s.ownerPct)} of supply`, 'A large share sits with the deployer.');
    if (s.contractPct >= 5) add('contract-supply', 'info', `${pct(s.contractPct)} sits in the contract itself`, 'Usually collected tax, waiting to be sold.');
    if (s.burnedPct >= 1) add('burned', 'info', `${pct(s.burnedPct)} burned`, 'Sent to a dead address for good.');
  }

  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const verdict: CheckVerdict = known
    ? 'official'
    : findings.some((x) => x.severity === 'danger')
      ? 'danger'
      : findings.some((x) => x.severity === 'warn')
        ? 'caution'
        : 'clean';

  return { verdict, known, impersonates, findings, headline: headlineFor(verdict, known, findings, f) };
}

function headlineFor(verdict: CheckVerdict, known: CheckKnown | null, findings: CheckFinding[], f: CheckFacts): string {
  if (known?.kind === 'stock') return `This is the real ${known.name} stock token, issued by Robinhood. Its price should track ${known.symbol}.`;
  if (known?.kind === 'rchan') return "That's me! $RCHAN, Robinchan's own token.";
  if (known?.kind === 'stable') return "That's USDG, Paxos' Global Dollar: the main dollar on Robinhood Chain.";
  if (known?.kind === 'wrapped') return "That's WETH, plain ether wrapped as a token.";

  const of = (severity: CheckFinding['severity']) => findings.filter((x) => x.severity === severity);
  if (verdict === 'danger') {
    const [a, b] = of('danger');
    return `Red flags here. ${a?.title ?? ''}${b ? `, and ${lowerFirst(b.title)}` : ''}.`;
  }
  if (verdict === 'caution') {
    const warns = of('warn');
    const list = warns.slice(0, 2).map((x) => lowerFirst(x.title));
    return `Nothing screams scam, but ${warns.length === 1 ? 'one thing stands out' : 'a few things stand out'}: ${list.join(' and ')}.`;
  }
  const parts: string[] = [];
  if (f.simulation.status === 'passed') parts.push('it sells with no tax');
  if (f.contract?.ownerState === 'renounced') parts.push('ownership is renounced');
  else if (f.contract?.ownerState === 'none') parts.push('it has no owner');
  if (f.market && f.market.liquidityUsd > 0) parts.push(`${formatUsdCompact(f.market.liquidityUsd)} sits in its pools`);
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing I check for came up');
  return `No red flags that I can find: ${said}. Prices can still swing hard.`;
}
