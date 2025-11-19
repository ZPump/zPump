# Mitigation: Dev-Skip Feature Still Present in Production Build

## Severity: CRITICAL
## Contract: ptf_verifier_groth16
## Issue ID: 2

## Problem Description

While warnings are logged, the dev-skip feature can still be compiled into production builds if `groth16-dev-skip` feature is enabled. The compile-time check only prevents both features together, but doesn't prevent dev-skip alone from being enabled.

## Security Impact

1. **Complete bypass of proof verification** - All proofs accepted if dev-skip enabled
2. **Unlimited token extraction** - Attackers can withdraw any amount
3. **Total loss of funds** - All funds in pools can be drained

## Mitigation Strategies

### Option 1: Compile-Time Panic (RECOMMENDED)
**Complexity:** Low  
**Time:** 1 day

Add compile-time check that panics in non-test builds:

```rust
#[cfg(all(feature = "groth16-dev-skip", not(test)))]
compile_error!(
    "groth16-dev-skip MUST NOT be enabled in non-test builds! \
     Use groth16-syscall for production builds."
);
```

### Option 2: Runtime Panic on Production Clusters
**Complexity:** Medium  
**Time:** 2-3 days

Add runtime check that panics on mainnet/testnet:

```rust
#[cfg(feature = "groth16-dev-skip")]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    // Runtime check for production clusters
    #[cfg(target_arch = "bpf")]
    {
        // Check cluster (mainnet/testnet)
        // This would require cluster detection or program ID check
        // For now, always panic in BPF builds with dev-skip
        panic!("DEV-SKIP MUST NOT BE ENABLED IN PRODUCTION BPF BUILDS!");
    }
    
    #[cfg(not(target_arch = "bpf"))]
    {
        // Allow for localhost/testing
        true
    }
}
```

### Option 3: CI/CD Check (REQUIRED)
**Complexity:** Low  
**Time:** 1 day

Add CI check that verifies production builds don't have dev-skip:

```bash
# In CI/CD pipeline
cargo build --release --features groth16-syscall
# Verify dev-skip is not in features
cargo tree | grep -q "groth16-dev-skip" && exit 1 || exit 0
```

## Recommended

**Combine Options 1 and 3:**
1. Add compile-time check to prevent accidental enablement
2. Add CI check as additional safety measure
3. Document in README that dev-skip is test-only

## References

- Issue location: `programs/verifier-groth16/src/lib.rs:271-281`
- Feature flags: `Cargo.toml`

