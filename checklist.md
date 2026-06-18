# Blockout — BNB Hack Compliance Checklist

Status as of code review on 2026-06-18. ✅ = exists and works · ⚠️ = exists but incomplete/wrong layer · ❌ = does not exist · 🔲 = needs your decision/input

---

## A. Mandatory — miss these and you can't compete or get disqualified

| # | Requirement | Status | Where it lives / what's missing |
|---|---|---|---|
| A1 | On-chain registration to competition contract `0x212c...aed5` before June 22 | ❌ | No registration code anywhere in `src/`. Needs `twak compete register` (or `competition_register` MCP) call + a hard startup gate refusing live mode without a confirmed registration record. **Single biggest blocker — has a fixed external deadline independent of everything else.** |
| A2 | Submit agent address + strategy write-up on DoraHacks | ❌ | Pure submission-process task, not code — but needs the wallet address from A1 first, and a written explanation of strategy/results (latter can't be finished until after the trading week). |
| A3 | Trade only the 149 eligible BEP-20 tokens | ❌ | No allowlist anywhere in code. `TRADING_PAIRS` config just validates regex shape (`[A-Z]+/[A-Z]+`), not membership in the eligible list. Trades on anything else **don't count toward scoring** — silent waste, not a hard error, which is worse because nothing will warn you. |
| A4 | At least 1 trade per day, 7 days straight, to qualify | ❌ | No trade-count tracking anywhere (`grep` for trade count/daily trade logic returns nothing). Needs a tracker + an alerting mechanism if a day is at risk of going trade-less (e.g. force a minimum-size trade late in the day if nothing fired naturally). |
| A5 | Hold non-zero in-scope balance at competition start (June 22) to be ranked at all | 🔲 | Operational, not code — needs you to manually ensure the registered wallet is funded with an eligible token before the window opens. Worth a pre-flight check script though. |
| A6 | Never let portfolio value start an hour at ≤$1 ("dust" = 0% that hour) | ❌ | `RiskManager.calculatePositionSize` has a `minPortfolioUsd` floor, but that's a *position-sizing* floor, not a guard against a withdrawal/swap sequence draining the wallet to dust. Needs new pre-trade logic: never execute a swap that would leave non-dust holdings at ≤$1. |
| A7 | Max drawdown cap — breach it and you're disqualified outright, regardless of PnL | ⚠️ | `RiskManager.checkDrawdown()` exists and works — but checks only every `drawdownCheckSec` (default 60s, configurable), and on breach it **halts new entries** via `circuitBreakerActive`, it does **not force-close open positions**. Given a DQ is automatic and unforgiving here, a once-a-minute check plus no auto-flatten is a real gap — between checks, or while existing positions ride out further loss, you could breach the cap and not find out until the next tick. 🔲 Decide: should breach auto-flatten all positions immediately, not just block new ones? |
| A8 | Self-custody signing via TWAK, not a local key | ❌ | Confirmed stub (`TWAKAdapter.ts` is `export {}`). Real signing is `ethers.Wallet` from a key on disk (`ExecutionService.loadOrCreateWallet`). This affects A1 too — registration itself should go through the same TWAK-signed wallet that trades, not a separate path. |
| A9 | No token launches / fundraising / airdrops during the event | 🔲 | Operational — nothing in the codebase does this, just confirm you don't accidentally trigger anything that looks like it (e.g. don't deploy any new contract during the window). |
| A10 | Public repo + demo link/video or clear setup instructions | 🔲 | Repo exists; README needs a rewrite pass (see B-section) before it's an honest "clear setup" doc. Demo video/link not yet made. |

---

## B. Special prize — Best Use of TWAK ($2,000) — scored out of 100

| # | Criterion (weight) | Status | Gap |
|---|---|---|---|
| B1 | TWAK integration depth (30 pts) — sole execution layer, multiple surfaces (signing + autonomous mode + x402) | ❌ | Zero TWAK usage currently. This is 30 of 100 points sitting at 0. |
| B2 | Self-custody integrity (25 pts) — local signing through the *entire* loop | ⚠️ | Signing IS local and self-custodial (ethers.Wallet, key never leaves disk) — but it's not TWAK, and the brief's penalty ladder cares about *how* custody is preserved through the agent's actual signing path. With the core trade loop on a non-TWAK local key, this likely lands in the "core trade loop depends on [non-target] custody path" range rather than top bracket, even though nothing here is *custodial* in the bad sense. |
| B3 | Autonomous execution + guardrails (20 pts) — drawdown caps, allowlists, per-trade/daily limits, slippage protection | ⚠️ | Drawdown cap ✅ exists (A7's caveats apply). Token allowlist ❌ (A3). Per-trade/daily limits — `maxPositionPct`/`maxExposurePct` exist ✅ but no *daily* trade-count limit either direction. Slippage protection ✅ genuinely solid (`SlippageConfigSchema`, retry-with-bump logic in `ExecutionService`). |
| B4 | Native x402 usage (10 pts) — actually paying per-request for data/inference/tools | ❌ | No x402 anywhere in the codebase. 🔲 Decide: is there a natural place to add this (e.g. pay-per-call to CMC Agent Hub via x402 instead of a flat API key) — worth doing for these 10 points if CMC Agent Hub supports it cleanly. |
| B5 | Originality / real-world relevance (10 pts) | ✅ likely fine | Multi-strategy regime-switching agent with MEV/TWAP defense is a reasonable, plausible real-world story already. |
| B6 | Demo quality with on-chain proof (5 pts) | 🔲 | Depends on B1/B2 being real — an on-chain proof of a non-TWAK ethers tx doesn't help this specific prize's story even though it's a real tx. |

**Current realistic score estimate for this prize: roughly 15-25 / 100** (B2 partial, B3 partial, B5 likely solid) — B1 and B4 being zero is the dominant factor. Fixing TWAK signing (B1) and adding x402 (B4) together close most of the gap.

---

## C. Special prize — Best Use of CMC Agent Hub ($2,000)

| # | Item | Status | Gap |
|---|---|---|---|
| C1 | Uses CMC Agent Hub layer (MCP / x402 / CLI / Skills) | ⚠️ | `MarketDataService.ts` hits raw CMC Pro API endpoints (`/v2/.../quotes/latest`, `/v2/.../ohlcv/historical`, `/v3/.../technical-indicator/latest`) — real and working, but not the Agent Hub layer specifically called out by this prize. There's even a self-aware log line noting the v3 indicator endpoint needs "Agent Hub tier" and falls back to neutral defaults without it. |
| C2 | Pre-computed signals (regime, liquidity, risk flags) vs. raw data + your own computation | ⚠️ | `SignalGenerator.ts` and `RegimeDetector.ts` compute RSI/MACD/Bollinger/regime locally from raw OHLCV — solid work, but it's *your* computation layered on raw data, not Agent Hub's pre-built signals. 🔲 Decide: worth adding an Agent Hub client alongside (not necessarily replacing) the existing pipeline, specifically to be judged on this. |
| C3 | Confirm your CMC key actually has Agent Hub access | 🔲 | Unknown — check your CMC plan/tier before assuming this is even available to you. |

---

## D. Special prize — Best Use of BNB AI Agent SDK ($2,000)

| # | Item | Status | Gap |
|---|---|---|---|
| D1 | Real usage of `@bnb-chain/bnbagent-sdk` | ❌ | `BNBAgentAdapter.ts` is also a comment-only stub, same pattern as TWAK. |
| D2 | Fit check — does this SDK (ERC-8004 identity / APEX agent commerce) actually serve a *trading* agent's story, or is it a different problem (agent-to-agent job marketplaces)? | 🔲 | Worth an honest "is this even the right tool" pass before sinking time in — covered in the fix prompt from earlier as Task 3's verification step. Possible this prize isn't a good ROI for your time vs. A/B above. |

---

## E. Things that already work well — don't touch / break these

| # | Item | Status |
|---|---|---|
| E1 | Drawdown circuit breaker (mechanism itself, separate from the gaps in A7) | ✅ |
| E2 | Slippage retry-with-bump on failed swaps | ✅ |
| E3 | Gas price retry-with-bump on underpriced/failed tx | ✅ |
| E4 | Nonce locking — prevents concurrent sends from colliding | ✅ |
| E5 | TWAP/MEV order-splitting above a USD threshold | ✅ |
| E6 | Atomic state persistence with checksums | ✅ |
| E7 | CMC quote/OHLCV fetch with backoff + circuit-open on repeated failure | ✅ |
| E8 | Multi-strategy regime switching (momentum/mean-reversion/range/scalping) | ✅ |
| E9 | Property-based + unit test coverage | ✅ |

---

## Suggested build order, given the June 21 deadline

1. **A1 (registration) + A8 (real TWAK signing)** — these are the same underlying work (swap `ExecutionService`'s signer to TWAK, then register through it) and are the two true blockers. Do these first, together.
2. **A3 (token allowlist) + A4 (daily trade tracking) + A6 (dust guard)** — all three are scoring-integrity issues; none are hard to build, but missing any one silently costs you ranked trades or a disqualifying dust hour without any error telling you so.
3. **A7 follow-up** — decide and implement whether drawdown breach should force-flatten positions, not just block new entries.
4. **B4 (x402)** — cheap points if CMC Hub supports it cleanly; do this once A-items are solid.
5. **C1/C2 (Agent Hub)** — worth doing if your CMC key has access; otherwise lower priority than A/B.
6. **D (BNB AI Agent SDK)** — lowest priority; verify fit before investing time, may not be worth it for this track's story.
7. **README rewrite + DoraHacks write-up** — last, once the above is real, so the docs describe what's actually true.