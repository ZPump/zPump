# Token Minting Cost Breakdown

## Overview

When minting a new token using `mint_native_ztoken`, the cost is **entirely network costs (Solana rent exemption)**, not protocol fees. We do NOT charge any additional fees beyond what Solana requires.

**Important**: We use Solana's **standard SPL Token-2022 program** - we did NOT create our own token system. The token itself is cheap (~0.00144 SOL). The cost comes from creating the **privacy infrastructure** that enables private shield/unshield operations.

## Cost Breakdown

The total cost is approximately **0.09-0.1 SOL** and consists of:

### Account Creation (Rent Exemption)

| Account | Size (bytes) | Approximate Cost | Purpose |
|---------|--------------|------------------|---------|
| **Mint Account** (SPL Token-2022) | 82 | ~0.00144 SOL | Standard Solana token mint |
| **Metadata Account** | 323 | ~0.00323 SOL | Token metadata (name, symbol, IPFS URI) |
| **MintMapping** | 81 | ~0.00081 SOL | Factory registry entry |
| **Pool State** | ~139 | ~0.00139 SOL | Privacy pool configuration |
| **Vault State** | ~72 | ~0.00072 SOL | Token vault configuration |
| **Commitment Tree** | ~3,759 | ~0.037 SOL | **Privacy: Merkle tree for private notes** |
| **Nullifier Set** (base) | 72 | ~0.00072 SOL | **Privacy: Prevents double-spending** |
| **Note Ledger** | ~233 | ~0.00233 SOL | **Privacy: Tracks private note creation/consumption** |
| **Hook Config** | ~43 | ~0.00043 SOL | Hook system configuration |
| **Hook Whitelist** | ~364 | ~0.00364 SOL | Hook whitelist for security |
| **User Token Account** (ATA) | 165 | ~0.00165 SOL | User's standard token account |
| **Vault Token Account** (ATA) | 165 | ~0.00165 SOL | Vault's standard token account |
| **Transaction Fees** | - | ~0.000005 SOL | Network transaction fees |
| **TOTAL** | **~5,318 bytes** | **~0.053-0.093 SOL** | |

### Why the Cost?

**We use Solana's standard SPL Token-2022 program** - the token itself is a standard Solana token and costs only ~0.00144 SOL to create.

The majority of the cost (~0.037 SOL) comes from the **CommitmentTree** account, which stores:
- Merkle tree frontier (for privacy proofs)
- Pre-computed zero values
- Canopy (for efficient proof generation)
- Recent commitments and amount commitments

This is **privacy infrastructure** - it's what enables users to:
- Shield tokens (make them private)
- Unshield tokens (redeem them back to public)
- Transfer tokens privately

**Without this infrastructure, you'd just have a regular Solana token** (costs ~0.00144 SOL), but users wouldn't be able to use privacy features.

## Standard Solana Token vs Our System

### Standard Solana Token (SPL Token-2022)
- **Cost**: ~0.00144 SOL
- **What you get**: A basic token that can be transferred publicly
- **Privacy**: None - all transfers are visible on-chain

### Our Privacy-Enabled Token
- **Cost**: ~0.053-0.093 SOL
- **What you get**: 
  - Standard Solana token (compatible with all Solana wallets/DEXs)
  - **PLUS** full privacy infrastructure
- **Privacy**: Users can shield tokens, transfer privately, and unshield
- **Breakdown**:
  - Token itself: ~0.00144 SOL (same as standard)
  - Privacy infrastructure: ~0.051-0.091 SOL (the extra cost)

## Important Notes

1. **We Use Solana's Standard Token Program**: We're using `TOKEN_2022_PROGRAM_ID` - the official Solana program. We did NOT create our own token system.

2. **No Protocol Fees**: We do NOT charge any additional fees. The entire cost is Solana's rent exemption system.

3. **Rent Exemption**: All accounts require rent exemption (locking SOL for ~2 years worth of rent). This SOL is not "spent" - it's locked in the accounts and can be recovered if the accounts are closed.

4. **CommitmentTree is Largest**: The CommitmentTree account stores the entire Merkle tree structure (frontier, zeroes, canopy, recent commitments) and is the largest single cost (~0.037 SOL). This is what enables privacy.

5. **One-Time Cost**: This is a one-time cost per token. Once the accounts are created, they remain on-chain and subsequent operations (shield, unshield, transfer) have much lower costs.

6. **Recoverable**: The rent can be recovered by closing accounts, though in practice these accounts remain open for the lifetime of the token.

7. **Bootstrap Before First Shield**: Run `npm run prepare:pool -- <originMint>` (or use the in-app prompt) once per mint to spin up the vault/pool/trees. After this bootstrap, every shield is a single transaction again.

## Comparison to Other Networks

- **Ethereum**: Creating an ERC-20 token costs ~$50-200 in gas fees
- **Solana Standard Token**: Creating a token costs ~0.00144 SOL (~$0.15 at $100/SOL)
- **Our Privacy Token**: Creating a token costs ~0.053-0.093 SOL (~$5-9 at $100/SOL)
  - Standard token portion: ~$0.15
  - Privacy infrastructure: ~$5-9

The extra cost is for the privacy infrastructure that enables private transfers.

## References

- [Solana Rent Documentation](https://docs.solana.com/developing/programming-model/accounts#rent)
- [Account Creation Costs](https://spl.solana.com/token#account-creation-costs)
- [SPL Token-2022 Program](https://spl.solana.com/token-2022)
