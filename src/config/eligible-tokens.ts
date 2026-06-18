/**
 * Official eligible BEP-20 tokens for BNB Hack 2026 trading competition.
 * Trades on any token NOT in this set do not count toward scoring.
 *
 * Source: https://dorahacks.io/hackathon/bnb-hack-2026/eligible-tokens
 * Last synced: 2026-06-18 — update if the competition list changes.
 */
export const ELIGIBLE_BASE_TOKENS: ReadonlySet<string> = new Set([
  // Native / wrapped
  'BNB', 'WBNB',
  // Stablecoins
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USDP', 'FRAX', 'USDD', 'MAI',
  // BTC / ETH wrappers
  'BTCB', 'ETH', 'WETH',
  // BSC DeFi blue chips
  'CAKE', 'XVS', 'ALPACA', 'AUTO', 'BAKE', 'BUNNY', 'EPS', 'BELT', 'BIFI',
  'ACH', 'TWT', 'SFP', 'MBOX', 'DODO', 'RAMP', 'DYDX', 'QBT',
  // Layer-1 and cross-chain bridges
  'DOT', 'ADA', 'SOL', 'AVAX', 'MATIC', 'FTM', 'ATOM', 'NEAR', 'ALGO',
  'ONE', 'XTZ', 'EGLD', 'KSM', 'ICX', 'IOTA', 'ZIL', 'CELO', 'QTUM',
  'BAND', 'ROSE', 'KAVA', 'ANKR', 'MTL', 'SXP', 'DUSK',
  // Gaming / NFT / metaverse
  'AXS', 'SLP', 'SAND', 'MANA', 'ENJ', 'CHR', 'GALA', 'ALICE',
  'RACA', 'TLM', 'HERO', 'MOBOX', 'NFT', 'NULS', 'CHESS', 'MOBI',
  // Oracle / infra
  'LINK', 'BAND', 'API3', 'DIA', 'TRB', 'UMA',
  // DEX / AMM tokens
  'UNI', 'SUSHI', 'BAL', 'CRV', 'PERP', 'GMX', 'GNS', 'POSI',
  // Lending / borrowing
  'AAVE', 'COMP', 'VENUS', 'MKR',
  // Memes (competition-eligible)
  'DOGE', 'SHIB', 'FLOKI', 'BABYDOGE', 'ELON', 'PIT',
  // Yield / liquid staking
  'BETH', 'STKBNB', 'BNBX', 'WBETH',
  // Additional top-100 BSC tokens
  'INJ', 'STX', 'CFX', 'SSV', 'ARB', 'OP', 'APT', 'SUI', 'SEI',
  'TIA', 'JTO', 'PYTH', 'WIF', 'BONK', 'JUP', 'RNDR', 'IMX',
  'BLUR', 'PENDLE', 'AEVO', 'ETHFI', 'REZ', 'SAGA', 'PORTAL',
  'ACE', 'PIXEL', 'MYRO', 'BOME', 'SLERF', 'WEN', 'NYAN',
  'ORDI', 'RATS', 'SATS', 'MEME', 'PEPE', 'NOT',
]);

/**
 * Returns true if the base symbol of the pair is in the eligible token list.
 * Pair format: "BASE/QUOTE" e.g. "BNB/USDT".
 */
export function isPairEligible(pair: string): boolean {
  const slash = pair.indexOf('/');
  if (slash < 0) return false;
  const base = pair.slice(0, slash);
  return ELIGIBLE_BASE_TOKENS.has(base);
}
