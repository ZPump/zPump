# Fee Calculation and Manipulation

## Severity: MEDIUM

## Description

The pool program calculates fees for shield and unshield operations. If fee calculations can be manipulated or bypassed, protocol revenue could be lost or users could be overcharged.

## Vulnerability Details

### Current Implementation

Fee calculation includes:
- `calculate_fee`: Calculates fee based on amount and fee_bps (lines 2972-2977)
- Fee validation in `validate_unshield_public_inputs`: Extracts fee from proof public inputs
- Protocol fees accumulation: `protocol_fees` field tracks accumulated fees
- Fee override support: Factory can set mint-specific fee overrides

### Potential Vulnerabilities

1. **Fee Bypass**: If fee validation is insufficient, fees could be bypassed or set to zero.

2. **Fee Calculation Overflow**: Fee calculation uses `checked_mul` but the result is cast to `u64` without checking if it fits.

3. **Fee Override Abuse**: Mint-specific fee overrides could be set to extreme values (0% or 100%), though there are some limits.

4. **Protocol Fees Overflow**: The `protocol_fees` field is `u128`, but if it overflows, fees could be lost.

5. **Fee Extraction from Proof**: Fees are extracted from proof public inputs. If the extraction is incorrect, wrong fees could be charged.

6. **Fee Mismatch**: If the fee in the proof doesn't match the calculated fee, validation might fail or allow incorrect fees.

7. **Zero Fee Exploitation**: If fees can be set to zero, the protocol loses revenue.

## Exploitation Scenario

```rust
// Scenario 1: Fee calculation overflow
// 1. User attempts to shield extremely large amount
// 2. amount * fee_bps calculation overflows u128
// 3. Result is cast to u64, causing incorrect fee
// 4. User pays wrong fee or transaction fails unexpectedly

// Scenario 2: Fee override abuse
// 1. Attacker compromises factory authority
// 2. Attacker sets fee_override to 0 for their mint
// 3. All operations on that mint have no fees
// 4. Protocol loses revenue

// Scenario 3: Fee extraction error
// 1. Proof has incorrect fee in public inputs
// 2. Fee extraction logic doesn't validate correctly
// 3. Wrong fee is charged or validation fails incorrectly
// 4. Users overcharged or protocol underpaid

// Scenario 4: Protocol fees overflow
// 1. Protocol accumulates fees over long period
// 2. protocol_fees approaches u128::MAX
// 3. Next fee addition overflows
// 4. Fees are lost or incorrect value stored
```

## Code References

- Fee calculation: `calculate_fee` (lines 2972-2977)
- Fee validation: `validate_unshield_public_inputs` (lines 3800-3946)
- Fee extraction: `decode_amount_from_field` (lines 3781-3784)
- Protocol fees: `protocol_fees` field in `PoolState`
- Fee override: Factory `fee_bps_override` in `MintMapping`

## Mitigation

1. **Strict Fee Validation**: Ensure fees extracted from proofs match calculated fees exactly.

2. **Fee Calculation Safety**: Add explicit overflow checks and ensure result fits in u64 before casting.

3. **Fee Override Limits**: Implement strict limits on fee overrides (e.g., 0.1% to 10%).

4. **Protocol Fees Monitoring**: Monitor protocol fees and implement a withdrawal mechanism before overflow.

5. **Fee Consistency Checks**: Validate that fees in proofs are consistent with pool state and calculations.

6. **Minimum Fee Enforcement**: Enforce a minimum fee to prevent zero-fee exploitation.

7. **Fee Event Logging**: Emit detailed events for all fee calculations and charges.

## Recommended Code Changes

```rust
// Enhanced fee calculation with overflow protection
impl PoolState {
    pub fn calculate_fee(&self, amount: u64) -> Result<u64> {
        // Use 128-bit intermediate to prevent overflow
        let amount_128 = amount as u128;
        let fee_bps_128 = self.fee_bps as u128;
        
        // Calculate fee: (amount * fee_bps) / 10000
        let fee_128 = amount_128
            .checked_mul(fee_bps_128)
            .ok_or(PoolError::FeeCalculationOverflow)?;
        let fee_128 = fee_128
            .checked_div(10_000)
            .ok_or(PoolError::FeeCalculationOverflow)?;
        
        // Ensure result fits in u64
        require!(
            fee_128 <= u64::MAX as u128,
            PoolError::FeeTooLarge
        );
        
        Ok(fee_128 as u64)
    }
    
    // Validate fee from proof matches calculated fee
    pub fn validate_fee(
        &self,
        amount: u64,
        fee_from_proof: u64,
    ) -> Result<()> {
        let calculated_fee = self.calculate_fee(amount)?;
        
        // Allow small rounding differences (1 lamport)
        let fee_diff = if calculated_fee > fee_from_proof {
            calculated_fee - fee_from_proof
        } else {
            fee_from_proof - calculated_fee
        };
        
        require!(
            fee_diff <= 1,
            PoolError::FeeMismatch
        );
        
        Ok(())
    }
}

// Enhanced protocol fees with overflow protection
pub fn add_protocol_fee(
    pool_state: &mut PoolState,
    fee: u64,
) -> Result<()> {
    let new_total = pool_state.protocol_fees
        .checked_add(u128::from(fee))
        .ok_or(PoolError::ProtocolFeesOverflow)?;
    
    // Check if approaching overflow (warn at 90% of max)
    const OVERFLOW_WARNING_THRESHOLD: u128 = u128::MAX / 10 * 9;
    if new_total > OVERFLOW_WARNING_THRESHOLD {
        msg!("WARNING: Protocol fees approaching overflow limit");
        // Emit event for monitoring
        emit!(ProtocolFeesWarning {
            current_total: pool_state.protocol_fees,
            new_total,
        });
    }
    
    pool_state.protocol_fees = new_total;
    Ok(())
}

// Fee override limits in factory
const MIN_FEE_OVERRIDE_BPS: u16 = 1; // 0.01% minimum
const MAX_FEE_OVERRIDE_BPS: u16 = 1000; // 10% maximum

pub fn register_mint(
    ctx: Context<RegisterMint>,
    // ... args ...
    fee_bps_override: Option<u16>,
) -> Result<()> {
    if let Some(fee) = fee_bps_override {
        require!(
            fee >= MIN_FEE_OVERRIDE_BPS && fee <= MAX_FEE_OVERRIDE_BPS,
            FactoryError::FeeOverrideOutOfRange
        );
    }
    // ... rest of registration ...
}
```

