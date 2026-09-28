import type { CheckCapability } from '@robinchan/shared';
import { toFunctionSelector } from 'viem';

/**
 * Owner-only powers, read from a contract's own code: a compiled contract
 * dispatches on 4-byte function selectors, each pushed with PUSH4, so the
 * selectors in its bytecode are the functions it has — verified source or
 * not. The signatures are the ones memecoin templates actually use.
 */
const CAPABILITY_SIGNATURES: Record<CheckCapability, string[]> = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'issue(uint256)'],
  blacklist: [
    'blacklist(address)',
    'blacklistAddress(address,bool)',
    'addToBlacklist(address)',
    'addBlacklist(address)',
    'setBlacklist(address,bool)',
    'setBlacklisted(address,bool)',
    'updateBlacklist(address,bool)',
    'setBots(address[],bool)',
    'setBot(address,bool)',
    'addBots(address[])',
    'blockBots(address[])',
    'freeze(address)',
    'freezeAccount(address,bool)',
  ],
  pause: ['pause()', 'unpause()', 'setPaused(bool)'],
  fees: [
    'setFee(uint256)',
    'setFees(uint256,uint256)',
    'setFees(uint256,uint256,uint256)',
    'setTax(uint256)',
    'setTax(uint256,uint256)',
    'setTaxes(uint256,uint256)',
    'setBuyFee(uint256)',
    'setSellFee(uint256)',
    'setBuyTax(uint256)',
    'setSellTax(uint256)',
    'setBuyFees(uint256,uint256)',
    'setSellFees(uint256,uint256)',
    'updateFees(uint256,uint256)',
    'updateBuyFees(uint256,uint256,uint256)',
    'updateSellFees(uint256,uint256,uint256)',
    'setTaxFeePercent(uint256)',
    'setFeePercent(uint256)',
    'setTransferFee(uint256)',
  ],
  limits: [
    'setMaxTxAmount(uint256)',
    'setMaxWalletSize(uint256)',
    'setMaxWallet(uint256)',
    'setMaxTransactionAmount(uint256)',
    'updateMaxTxnAmount(uint256)',
    'updateMaxWalletAmount(uint256)',
    'setMaxTxPercent(uint256)',
    'setMaxWalletPercent(uint256)',
  ],
  trading: [
    'enableTrading()',
    'openTrading()',
    'startTrading()',
    'setTradingEnabled(bool)',
    'setTradingActive(bool)',
    'setTrading(bool)',
    'setTradingOpen(bool)',
  ],
  roles: ['grantRole(bytes32,address)'],
};

/** UUPS: the implementation carries its own upgrade function. */
const UPGRADE_SIGNATURES = ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'];

const toSelectors = (sigs: string[]) => sigs.map((s) => toFunctionSelector(`function ${s}`).slice(2).toLowerCase());

const CAPABILITY_SELECTORS = Object.fromEntries(
  Object.entries(CAPABILITY_SIGNATURES).map(([cap, sigs]) => [cap, toSelectors(sigs)]),
) as Record<CheckCapability, string[]>;
const UPGRADE_SELECTORS = toSelectors(UPGRADE_SIGNATURES);

/** Every PUSH4 operand in the code — skipping over the data of the other PUSHes, so no data byte is read as an opcode. */
export function pushedSelectors(code: string): Set<string> {
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  const out = new Set<string>();
  for (let i = 0; i < hex.length; ) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    if (op >= 0x60 && op <= 0x7f) {
      const size = op - 0x5f;
      if (op === 0x63) out.add(hex.slice(i, i + 8).toLowerCase());
      i += size * 2;
    }
  }
  return out;
}

export function capabilitiesIn(code: string): { capabilities: CheckCapability[]; uups: boolean } {
  const selectors = pushedSelectors(code);
  const capabilities = (Object.keys(CAPABILITY_SELECTORS) as CheckCapability[]).filter((cap) =>
    CAPABILITY_SELECTORS[cap].some((s) => selectors.has(s)),
  );
  return { capabilities, uups: UPGRADE_SELECTORS.some((s) => selectors.has(s)) };
}

/**
 * A minimal proxy: a fixed clone of one implementation, not upgradeable —
 * EIP-1167 and its variants (Solady's, EIP-7511's PUSH0 one), which launchpads
 * deploy by the thousand. All are a few dozen bytes that push the target
 * (PUSH20) and DELEGATECALL to it (GAS, DELEGATECALL).
 */
export function cloneTarget(code: string): string | null {
  if (code.length > 2 + 2 * 96) return null;
  const m = /73([0-9a-f]{40})5af4/i.exec(code);
  return m ? `0x${m[1]}` : null;
}

/** EIP-1967 storage slots. */
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** The address in the low 20 bytes of a storage word; null for an empty slot. */
export function slotAddress(word: string | undefined | null): string | null {
  if (!word || /^0x0*$/.test(word)) return null;
  const hex = word.slice(2).padStart(64, '0');
  const addr = `0x${hex.slice(24)}`;
  return /^0x0{40}$/.test(addr) ? null : addr;
}
