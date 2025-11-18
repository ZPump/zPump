# Mitigation: Allowance Amount Mismatch Check

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 11

## Problem Description

The check requires `allowance_amount == spend_amount` but doesn't account for fees. This could prevent valid transfers.

## Security Impact

1. **Valid Transfers Blocked:** Transfers with fees might be incorrectly rejected
2. **User Confusion:** Unclear what spend_amount should be
3. **Operational Issues:** Could prevent legitimate operations

## Mitigation

Clarify and fix the check:

```rust
pub fn transfer_from(ctx: Context<TransferFrom>, args: TransferFromArgs) -> Result<()> {
    require!(args.allowance_amount > 0, PoolError::AllowanceAmountInvalid);
    require!(args.spend_amount > 0, PoolError::AllowanceAmountInvalid);
    
    // FIX: spend_amount should be the amount being spent from allowance
    // This should match the sum of outputs going to others (excluding change back to owner)
    // If fees are involved, they should be accounted for
    
    // Option 1: spend_amount should equal allowance_amount (if no fees)
    // Option 2: spend_amount + fee should equal allowance_amount (if fees apply)
    
    // For now, require exact match (assuming no fees in transfer)
    require!(
        args.allowance_amount == args.spend_amount,
        PoolError::AllowanceAmountMismatch
    );
    
    // TODO: If transfer includes fees, update check to:
    // let total_cost = args.spend_amount.checked_add(fee)
    //     .ok_or(PoolError::AmountOverflow)?;
    // require!(
    //     args.allowance_amount >= total_cost,
    //     PoolError::AllowanceInsufficient
    // );
    
    // ... rest of function
}
```

## Documentation

Clearly document what `spend_amount` represents and how it relates to `allowance_amount` and fees.

## References

- Issue location: `programs/pool/src/lib.rs:956-962`

