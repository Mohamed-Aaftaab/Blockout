You are working in the Blockout repo (TypeScript, BNB Hack 2026 trading agent —
src/ has market/, execution/, risk/, strategies/, state/, config/, etc.).

CONTEXT: The README claims TWAK and BNB AI Agent SDK integrations that do not
exist in code. Two adapter files are documentation-only stubs with no runtime
code. There is also no on-chain competition registration anywhere in the repo,
which is a hard hackathon requirement with a fixed deadline. Fix these in order.
Do not mark anything "done" in the README until the corresponding code actually
runs and is covered by a test.

=== TASK 1: Real TWAK integration (replaces ethers.Wallet-on-disk signing) ===

Current state: src/execution/TWAKAdapter.ts is a comment-only stub (`export {}`).
Real signing happens in src/execution/ExecutionService.ts via
`loadOrCreateWallet()`, which creates/loads a raw private key at
./data/wallet.key and signs locally with ethers.Wallet.

1. Check whether `@trustwallet/agent-sdk` is now published on npm, or whether
   TWAK is meant to be used via its CLI (`twak`, installed via
   `curl -fsSL https://agent-kit.trustwallet.com/install.sh | bash`) or its MCP
   server (`twak serve`). Do not assume — verify by running
   `npm view @trustwallet/agent-sdk` and/or checking if `twak` is on PATH.
   Report what you find before writing integration code.
2. Based on what's actually available, implement TWAKAdapter.ts for real:
   - If the npm SDK exists: initialize it with TWAK_ACCESS_ID / TWAK_HMAC_SECRET
     (already validated in src/config/schema.ts — twakAccessId/twakHmacSecret),
     and implement sign()/broadcast()/getBalance() per the JSDoc contract
     already sketched in the stub file.
   - If only the CLI/MCP exists: implement a thin wrapper that shells out to
     `twak` (subprocess) or calls the MCP server as a tool, matching the same
     interface shape (sign, broadcast, balance) so ExecutionService doesn't
     need to know which transport is underneath.
   - Either way, follow the existing degrade-gracefully pattern used elsewhere
     in this codebase (e.g. MarketDataService's circuit-open-on-failure) —
     if TWAK is unreachable, fail loudly and refuse to trade rather than
     silently falling back to the local ethers.Wallet.
3. Update ExecutionService.initialize() and sendRawTx() to use the new
   TWAKAdapter for signing instead of `this.wallet.connect(provider)`.
   Keep the existing nonce-lock logic — TWAK signing must still be serialized
   the same way raw ethers signing was.
4. Add/update tests mirroring the style of src/__tests__/gas.test.ts and
   mev.test.ts: mock the TWAK transport, assert sign() is actually called for
   every order, assert the agent refuses to execute if TWAK init fails.
5. Update README.md's TWAK section to describe what's actually implemented,
   not what's planned.

=== TASK 2: On-chain competition registration (currently missing entirely) ===

There is NO registration code anywhere in src/. This must exist before the
agent can legally compete — the contract rejects entries after the trading
window opens, so this has a hard external deadline independent of how
finished the rest of the agent is.

1. Implement a registration call to the competition contract
   (0x212c61b9b72c95d95bf29cf032f5e5635629aed5 on BSC) via TWAK
   (`twak compete register` CLI, or `competition_register` MCP action —
   confirm exact invocation once Task 1's verification step is done).
2. Add a `competitionRegistration` section to state (src/state/StateManager.ts
   and its migrations) recording: wallet address, registration tx hash,
   timestamp, and a confirmed boolean.
3. In src/index.ts startup sequence, add a hard gate: if `network.mode ===
   'mainnet'` (live competition mode) and no confirmed registration exists in
   state, refuse to start and log clearly what command to run to register.
4. Add a CLI entrypoint or npm script (e.g. `npm run register`) that performs
   registration as a standalone one-off action, separate from the main agent
   loop, so it can be run and verified well before the trading window opens.
5. Add a test asserting the agent refuses to start in live mode without a
   confirmed registration record.

=== TASK 3: BNB AI Agent SDK — same treatment as Task 1 ===

src/execution/BNBAgentAdapter.ts is also a comment-only stub. Repeat the same
process as Task 1: verify what's actually available right now
(`@bnb-chain/bnbagent-sdk` on npm — note this package is for ERC-8004 identity
+ APEX agent commerce, NOT the trading-competition registration path, so don't
conflate it with Task 2). Decide honestly whether integrating it adds real
judged value for this specific competition (identity registration /
discoverability) versus being integration-for-its-own-sake. Report your
recommendation before writing code — if it's not a good fit, say so and update
the README to stop claiming a planned integration that doesn't serve this
track.

=== TASK 4: CMC Agent Hub vs raw Pro API ===

src/market/MarketDataService.ts currently calls raw CMC Pro API endpoints
(/v2/cryptocurrency/quotes/latest, /v2/.../ohlcv/historical,
/v3/.../technical-indicator/latest), with a fallback-to-neutral-defaults when
the v3 indicator endpoint isn't available on the current API tier (see the
logger.warn in fetchIndicators()).

1. Check whether the configured CMC_API_KEY has CMC Agent Hub / MCP access
   (the pre-computed regime/liquidity/risk-flag layer specifically called out
   in the hackathon brief), separate from plain Pro API access.
2. If available, add an Agent Hub client alongside (not necessarily replacing)
   the existing MarketDataService, and report on whether its pre-computed
   signals are a better fit than the raw indicator computation already
   happening in src/market/SignalGenerator.ts. Don't rip out working code
   without confirming the replacement is actually better.
3. Either way, fix the README's CMC section to accurately describe which
   layer (raw Pro API vs Agent Hub) is actually being used and why.

=== GENERAL RULES ===
- Do not delete or weaken any existing risk control (drawdown circuit breaker,
  position/exposure caps, slippage retry logic, TWAP/MEV defense) while making
  these changes.
- Run `npm test` and `npm run typecheck` after each task and fix any breakage
  before moving to the next task.
- After all four tasks, do a final pass on README.md so every claimed
  integration matches what the code actually does — no aspirational sections.
- If at any point a step is blocked on something only the human can do
  (installing a CLI, generating credentials, confirming API tier), stop and
  report exactly what's needed rather than stubbing around it.s