# Token Minting Cost Breakdown

## Overview

When minting a new token using `mint_native_ztoken`, the cost is **entirely network costs (Solana rent exemption)**, not protocol fees. We do NOT charge any additional fees beyond what Solana requires.

## Cost Breakdown

The total cost is approximately **0.09-0.1 SOL** and consists of:

### Account Creation (Rent Exemption)

| Account | Size (bytes) | Approximate Cost |
|---------|--------------|------------------|
| **Mint Account** (Token2022) | 82 | ~0.00144 SOL |
| **Metadata Account** | 323 | ~0.00323 SOL |
| **MintMapping** | 81 | ~0.00081 SOL |
| **Pool State** | ~139 | ~0.00139 SOL |
| **Vault State** | ~72 | ~0.00072 SOL |
| **Commitment Tree** | ~3,759 | ~0.037 SOL |
| **Nullifier Set** (base) | 72 | ~0.00072 SOL |
| **Note Ledger** | ~233 | ~0.00233 SOL |
| **Hook Config** | ~43 | ~0.00043 SOL |
| **Hook Whitelist** | ~364 | ~0.00364 SOL |
| **User Token Account** (ATA) | 165 | ~0.00165 SOL |
| **Vault Token Account** (ATA) | 165 | ~0.00165 SOL |
| **Transaction Fees** | - | ~0.000005 SOL |
| **TOTAL** | **~5,318 bytes** | **~0.053 SOL** |

### Important Notes

1. **No Protocol Fees**: We do NOT charge any additional fees. The entire cost is Solana's rent exemption system.

2. **Rent Exemption**: All accounts require rent exemption (locking SOL for ~2 years worth of rent). This SOL is not "spent" - it's locked in the accounts and can be recovered if the accounts are closed.

3. **CommitmentTree is Largest**: The CommitmentTree account stores the entire Merkle tree structure (frontier, zeroes, canopy, recent commitments) and is the largest single cost (~0.037 SOL).

4. **One-Time Cost**: This is a one-time cost per token. Once the accounts are created, they remain on-chain and subsequent operations (shield, unshield, transfer) have much lower costs.

5. **Recoverable**: The rent can be recovered by closing accounts, though in practice these accounts remain open for the lifetime of the token.

## Comparison to Other Networks

- **Ethereum**: Creating an ERC-20 token costs ~$50-200 in gas fees
- **Solana**: Creating a token costs ~$0.50-1.00 (at current SOL prices) in rent exemption
- **Our System**: Same as Solana - no additional fees

## Future Optimizations

Potential ways to reduce costs in the future:
1. **Shared Commitment Trees**: Multiple tokens could share a commitment tree (complex)
2. **Lazy Initialization**: Defer creating some accounts until first use (reduces initial cost but adds complexity)
3. **Rent Optimization**: Use smaller account sizes where possible

However, the current ~0.053 SOL cost is already very reasonable compared to other networks.

## References

- [Solana Rent Documentation](https://docs.solana.com/developing/programming-model/accounts#rent)
- [Account Creation Costs](https://spl.solana.com/token#account-creation-costs)

