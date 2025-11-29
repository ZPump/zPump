# What's Left to Complete - DEX Implementation

## Summary

The zToken CPI **framework** is complete (648 lines), but the **integration** into instruction handlers still needs work. Here's what remains:

## 🔴 High Priority - Complete zToken Integration

### 1. Integrate CPI Calls into Instruction Handlers

**Status:** Framework ready, but TODOs remain in instruction handlers

**What Needs to Be Done:**

#### `create_pool.rs` (2 TODOs)
- [ ] Line 134: Replace TODO with actual shield CPI call for token A
- [ ] Line 244-280: Parse zToken accounts and invoke shield CPI (when SDK provides proof data)

**Current State:**
- Framework functions ready (`invoke_shield_cpi`, `parse_ztoken_accounts`)
- Instruction signature needs `ShieldArgs` parameters (optional)
- Need to parse accounts and call CPI

#### `add_liquidity.rs` (4 TODOs)
- [ ] Line 39, 45: Get private reserves from commitments (currently returns 0)
- [ ] Line 103-107: Implement private_transfer CPI for token A
- [ ] Line 130-134: Implement private_transfer CPI for token B

**Current State:**
- Framework ready (`invoke_transfer_cpi`)
- Need to:
  - Parse zToken accounts from remaining_accounts
  - Call private_transfer CPI (user → pool PDA)
  - Update private reserve commitments

#### `remove_liquidity.rs` (5 TODOs)
- [ ] Line 44, 50: Get private reserves from commitments (currently returns 0)
- [ ] Line 105-109: Implement private_transfer CPI for token A (pool PDA → user)
- [ ] Line 121-125: Implement private_transfer CPI for token B (pool PDA → user)

**Current State:**
- Framework ready (`invoke_transfer_cpi` with PDA signing)
- Need to:
  - Parse zToken accounts from remaining_accounts
  - Call private_transfer CPI with pool PDA as signer
  - Update private reserve commitments

#### `swap.rs` (6 TODOs)
- [ ] Line 36, 41, 51, 56: Get private reserves from commitments (currently returns 0)
- [ ] Line 153: Handle zToken private reserve updates
- [ ] Line 193-197: Implement private_transfer CPI for zToken input
- [ ] Line 233-241: Implement shield/private_transfer CPI for zToken output

**Current State:**
- Framework ready for both shield and transfer CPIs
- Need to handle 4 swap types:
  - Public → Public ✅ (already working)
  - zToken → zToken (private_transfer both sides)
  - Public → zToken (shield output)
  - zToken → Public (private_transfer from pool)

#### `collect_fees.rs` (2 TODOs)
- [ ] Line 58, 74: Handle zToken protocol fee collection
- Note: LP fees auto-compound into reserves, so no special handling needed

### 2. Private Reserve Tracking Implementation

**What's Missing:**
- [ ] Get private reserve amounts from commitments (currently returns 0)
- [ ] Update commitments after zToken operations
- [ ] Calculate LP tokens using total value (public + private reserves)

**Where It's Needed:**
- Swap calculations (reserve amounts)
- LP token calculations (total pool value)
- Reserve ratio calculations

**Current State:**
- `PoolState` has `private_reserve_a_commitment` and `private_reserve_b_commitment` fields ✅
- Helper methods exist (`update_private_reserve_*_commitment`) ✅
- But we can't get actual amounts from commitments (privacy requirement)
- Need to track amounts separately or use a different approach

**Solution Options:**
1. Store private reserve amounts (breaks privacy slightly, but needed for AMM math)
2. Use commitment tree queries (requires indexer)
3. Calculate from public inputs (when available)

### 3. SDK Integration for zToken Operations

**What SDK Needs to Do:**

#### Proof Generation
- [ ] Generate shield proofs via ProofClient for Public → zToken swaps
- [ ] Generate transfer proofs via ProofClient for zToken operations
- [ ] Handle multi-transaction flows (shield + finalize_tree + finalize_ledger)

#### Account Passing
- [ ] Derive all zToken pool PDAs
- [ ] Pass accounts via `remaining_accounts` in correct order:
  - Shield: 14 accounts
  - Transfer: 7 accounts
- [ ] Include all required accounts for each operation type

#### Instruction Parameters
- [ ] Add optional `ShieldArgs`/`TransferArgs` to instruction signatures
- [ ] Serialize and pass proof data
- [ ] Handle conditional account inclusion based on token types

**Files to Update:**
- `web/app/lib/sdk.ts` - Add proof generation and account derivation
- Instruction builders - Add proof data parameters

## 🟡 Medium Priority - Testing & Validation

### 4. Complete Test Coverage

**What's Missing:**
- [ ] Test all 4 swap types end-to-end:
  - Public → Public ✅ (tested)
  - zToken → zToken (not tested)
  - Public → zToken (not tested)
  - zToken → Public (not tested)
- [ ] Test zToken liquidity operations:
  - Add liquidity with zToken
  - Remove liquidity with zToken
- [ ] Test zToken privacy (verify never unshielded)
- [ ] Edge cases for zToken operations
- [ ] Multi-user zToken scenarios

**Test Files:**
- `web/app/scripts/dex-lowlevel-e2e.ts` - Add zToken test cases
- `web/app/scripts/dex-highlevel-e2e.ts` - Add zToken user flows

### 5. Integration Testing

- [ ] Run full test suite and fix any failures
- [ ] Verify all tests pass in CI
- [ ] Validate zToken operations don't break existing functionality

## 🟢 Low Priority - Documentation & Polish

### 6. Documentation (Missing - 0%)

- [ ] `docs/smart-contracts/ptf-dex.md` - Program architecture
- [ ] `docs/architecture/dex-integration.md` - Integration with pool/vault
- [ ] `docs/frontend/dex-ui.md` - UI component structure
- [ ] `docs/operations/dex-operations.md` - Operations guide
- [ ] Update `docs/overview/overview.md` - Add DEX section
- [ ] Update `docs/README.md` - Add DEX to feature list

### 7. Security Review

- [ ] Verify zTokens never unshield during DEX operations
- [ ] Review reentrancy protection
- [ ] Validate slippage protection for all operations
- [ ] Math overflow checks for all calculations
- [ ] Private reserve integrity validation

### 8. Gas Optimization

- [ ] Minimize account reads/writes
- [ ] Optimize reserve calculations
- [ ] Verify compute unit limits are acceptable
- [ ] Test with all security features enabled

## Detailed Breakdown by File

### Files with TODOs (44 total)

1. **create_pool.rs** - 3 TODOs
   - Shield CPI integration points

2. **add_liquidity.rs** - 4 TODOs
   - Private reserve tracking (2)
   - Transfer CPI integration (2)

3. **remove_liquidity.rs** - 5 TODOs
   - Private reserve tracking (2)
   - Transfer CPI integration (2)
   - General zToken handling (1)

4. **swap.rs** - 6 TODOs
   - Private reserve tracking (4)
   - Transfer/shield CPI integration (2)

5. **collect_fees.rs** - 2 TODOs
   - zToken protocol fee collection

6. **ztoken.rs** - 1 TODO
   - Mint validation check

## Estimated Time Remaining

### Critical Path (Must Complete)
1. **Integrate CPI calls** - 2-3 days
   - Update instruction handlers
   - Add proof data parameters
   - Connect framework functions

2. **Private reserve tracking** - 1-2 days
   - Implement amount tracking
   - Update reserve calculations

3. **SDK integration** - 3-4 days
   - Proof generation
   - Account derivation
   - Instruction building

### Testing & Validation
4. **Complete test coverage** - 2-3 days
5. **Integration testing** - 1 day

### Polish
6. **Documentation** - 2-3 days
7. **Security review** - 1-2 days
8. **Gas optimization** - 1 day

**Total Critical Path: 6-9 days**  
**Total with Testing: 9-13 days**  
**Total Complete: 13-19 days**

## Current Status

| Component | Status | Completion | Next Step |
|-----------|--------|------------|-----------|
| zToken CPI Framework | ✅ Complete | 100% | Use in instructions |
| CPI Integration | ⚠️ Framework Ready | 20% | Connect to handlers |
| Private Reserve Tracking | ⚠️ Structure Ready | 30% | Implement amount tracking |
| SDK Integration | ❌ Not Started | 0% | Add proof generation |
| Testing (zToken) | ⚠️ Partial | 10% | Add zToken test cases |
| Documentation | ❌ Missing | 0% | Write docs |

## Priority Order

1. **First:** Integrate CPI calls into instruction handlers
2. **Second:** Implement private reserve tracking
3. **Third:** SDK integration (proof generation)
4. **Fourth:** Testing and validation
5. **Fifth:** Documentation and polish

## Key Blockers

1. **Private Reserve Amount Tracking** - Can't get amounts from commitments (privacy). Need solution.
2. **SDK Proof Generation** - Requires ProofClient integration and multi-transaction flows
3. **Instruction Parameter Updates** - Need to add optional proof data parameters

---

**Bottom Line:** Framework is ready (95%), but integration is at 20%. Need to connect the framework functions to the instruction handlers and solve private reserve amount tracking.

