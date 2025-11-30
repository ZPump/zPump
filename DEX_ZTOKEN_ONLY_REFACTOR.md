# DEX zToken-Only Refactoring Plan

## Overview
Simplify the DEX to only work with zTokens (private tokens), removing:
- Public SPL token support
- SOL compatibility in DEX (keep only for shield/unshield)

## Program Changes Required

### 1. PoolState (`programs/dex/src/state/pool_state.rs`)
- ✅ Remove `token_a_is_ztoken` and `token_b_is_ztoken` flags (both always true)
- ✅ Remove `public_reserve_a` and `public_reserve_b` fields
- ✅ Update LEN calculation
- ✅ Simplify helper methods

### 2. Instruction Signatures (`programs/dex/src/lib.rs`)
- ✅ Remove `token_a_is_ztoken` and `token_b_is_ztoken` parameters
- ✅ Change `Option<ShieldArgs>` to `ShieldArgs` (required)
- ✅ Change `Option<TransferArgs>` to `TransferArgs` (required)
- ✅ Remove `shield_args_out` from swap (only zToken→zToken swaps)

### 3. Account Structs (`programs/dex/src/lib.rs`)
- Remove public token accounts:
  - `user_token_a_account` (optional - only for public tokens)
  - `pool_token_a_account` (optional - only for public tokens)
  - `user_token_b_account` (optional - only for public tokens)
  - `pool_token_b_account` (optional - only for public tokens)
- Remove `token_program` and `associated_token_program` from CreatePool

### 4. create_pool Instruction
- ✅ Remove all public token transfer logic
- ✅ Require shield_args_a and shield_args_b (not optional)
- ✅ Always invoke shield CPI for both tokens

### 5. add_liquidity Instruction
- Remove public token transfer logic
- Require transfer_args_a and transfer_args_b
- Always use private transfer CPIs

### 6. remove_liquidity Instruction
- Remove public token transfer logic
- Require transfer_args_a and transfer_args_b
- Always use private transfer CPIs

### 7. swap Instruction
- Remove public token transfer logic
- Remove shield_args_out (no Public → zToken swaps)
- Only support zToken → zToken swaps
- Require transfer_args_in and transfer_args_out

### 8. collect_fees Instruction
- Remove public token fee collection logic
- Fees are always in private reserves (handled separately)

## SDK Changes Required (`web/app/lib/sdk.ts`)

### 1. createDexPool
- Remove SOL wrapping logic
- Remove public token account creation
- Always require ShieldArgs for both tokens
- Only accept zToken mints

### 2. addDexLiquidity
- Remove SOL wrapping logic
- Remove public token transfers
- Always require TransferArgs
- Only accept zToken mints

### 3. removeDexLiquidity
- Remove SOL unwrapping logic
- Remove public token transfers
- Always require TransferArgs
- Only accept zToken mints

### 4. swapDex
- Remove SOL wrapping/unwrapping logic
- Remove public token swaps
- Only support zToken → zToken swaps
- Require TransferArgs for both input and output

## Frontend Changes Required

### 1. TokenSelector (`web/app/components/dex/TokenSelector.tsx`)
- Filter to only show zTokens (private tokens)
- Remove SOL option
- Remove public token options

### 2. LiquidityForm (`web/app/components/dex/LiquidityForm.tsx`)
- Remove public token handling
- Always pass zToken mints
- Always require proof generation

### 3. SwapForm (`web/app/components/dex/SwapForm.tsx`)
- Remove public token swaps
- Only show zToken → zToken swaps

## Security Benefits
1. Reduced attack surface - no public token handling
2. Consistent privacy model - all operations are private
3. Simpler codebase - less conditional logic
4. No SOL compatibility issues in DEX
