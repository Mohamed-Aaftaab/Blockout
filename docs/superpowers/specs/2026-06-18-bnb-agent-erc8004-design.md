# BNB Agent ERC-8004 Identity Registration — Design Spec

**Date:** 2026-06-18  
**Status:** Approved

---

## Goal

Register Blockout as a discoverable on-chain agent via ERC-8004 (BNB Identity Registry), making it visible in the BNB Agent ecosystem for hackathon judging. One-time setup, stored in persisted state.

---

## Context & Constraints

- The BNB Agent SDK (`bnb-chain/bnbagent-sdk`) is **Python-only** — no npm package exists.
- Integration is done by calling the Identity Registry smart contract **directly via ethers v6**, using the ABI fetched from the SDK repo. No Python runtime required.
- ERC-8183 (agentic commerce / job stack) is **out of scope** — not applicable to an autonomous trading bot.
- Signing follows the existing TWAK path: `TWAKAdapter.sign()` → `provider.broadcastTransaction()`.
- Gas-free registration is available on BSC Testnet via MegaFuel paymaster (the Python SDK handles this; our ethers path will pay gas normally — this is acceptable for a hackathon).

---

## Contract Addresses

| Network | Contract | Address |
|---------|----------|---------|
| BSC Testnet (97) | Identity Registry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| BSC Mainnet (56) | Identity Registry (ERC-8004) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

### ABI — relevant function

```json
{
  "name": "register",
  "inputs": [{ "name": "agentURI", "type": "string" }],
  "outputs": [{ "name": "agentId", "type": "uint256" }],
  "stateMutability": "nonpayable",
  "type": "function"
}
```

`agentURI` is a JSON metadata URI describing the agent (name, description, endpoints). We build it inline as a `data:application/json;base64,...` URI — no external hosting needed.

---

## Architecture

### New / changed files

| File | Action | Purpose |
|------|--------|---------|
| `src/execution/abis/IdentityRegistry.json` | Create | ERC-8004 ABI (copied from SDK repo) |
| `src/execution/BNBAgentAdapter.ts` | Replace stub | Calls `register(agentURI)` via ethers; returns `{ agentId, txHash }` |
| `src/types/index.ts` | Modify | Add `bnbAgentId: string \| null` to `SystemState` |
| `src/state/StateManager.ts` | Modify | Add `bnbAgentId` to Zod schema with `.default(null)` |
| `src/state/migrations/v3_to_v4.ts` | Create | Backfill `bnbAgentId: null` for old state files |
| `src/registration/RegistrationService.ts` | Modify | Call `BNBAgentAdapter.registerIdentity()` in `register()`, store `agentId` |
| `src/__tests__/bnbagent.test.ts` | Create | Unit tests for `BNBAgentAdapter` |

---

## Component Design

### `BNBAgentAdapter`

```typescript
class BNBAgentAdapter {
  constructor(config: ConfigurationService, twakAdapter: TWAKAdapter) {}

  // Registers the agent on the ERC-8004 Identity Registry.
  // Returns agentId (uint256 as string) and txHash.
  // Throws if already registered (contract reverts) or if TWAK signing fails.
  async registerIdentity(): Promise<{ agentId: string; txHash: string }>;

  // Returns the agentId for this wallet if already registered, else null.
  async getAgentId(walletAddress: string): Promise<string | null>;
}
```

**Implementation detail:** `registerIdentity()` encodes `register(agentURI)` calldata using ethers `Interface`, then hands the raw tx through `TWAKAdapter.sign()` exactly as `ExecutionService.sendRawTx()` does. The `agentURI` is a `data:` URI so no external server is needed:

```typescript
const metadata = {
  name: 'Blockout',
  description: 'Autonomous MEV-resistant trading agent on BNB Smart Chain',
  version: '1.0.0',
};
const agentURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(metadata)).toString('base64');
```

The `agentId` returned by `register()` is extracted from the transaction receipt's `Transfer` event log (ERC-721 mint: `Transfer(address(0), wallet, agentId)`).

### State changes

`SystemState` gains:

```typescript
bnbAgentId: string | null;  // uint256 agentId as decimal string, null until registered
```

### `npm run register` flow (updated)

```
1. Load config + state
2. Skip if already registered (state.competitionRegistration.confirmed AND state.bnbAgentId)
3. registerIdentity() via BNBAgentAdapter  → stores bnbAgentId in state
4. register() via RegistrationService      → stores competitionRegistration in state
5. Save state
6. Log both results
```

Steps 3 and 4 run sequentially (not parallel) so a partial failure is easy to retry.

---

## Error Handling

- If `registerIdentity()` fails: log the error, skip storing `bnbAgentId`, continue with competition registration. A failed ERC-8004 registration should not block competition entry.
- If the wallet already has an `agentId` on-chain: `getAgentId()` short-circuits and skips re-registration.
- No startup gate for `bnbAgentId` — identity is optional for the agent to function.

---

## Testing

Mock `ethers.Contract` (or the provider's `broadcastTransaction`) in `bnbagent.test.ts`:
- `registerIdentity()` encodes correct calldata and extracts `agentId` from a mocked receipt
- `registerIdentity()` throws on a reverted tx (already registered)
- `getAgentId()` returns null when `balanceOf(wallet) === 0`
- `getAgentId()` returns the agentId when `balanceOf(wallet) > 0`

Style: same mock-heavy pattern as `gas.test.ts` / `twak.test.ts`.

---

## What does NOT change

- All existing risk controls (drawdown breaker, position caps, slippage, MEV defense) are untouched.
- `ExecutionService`, `TradingEngine`, and `RiskManager` are untouched.
- Competition registration logic in `RegistrationService` is extended, not replaced.

---

## Out of Scope

- ERC-8183 (agentic commerce / job stack)
- MegaFuel paymaster gas sponsorship (adds complexity; gas is cheap on testnet)
- Agent URI hosted on IPFS (inline `data:` URI is sufficient for hackathon)
