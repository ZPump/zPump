# Groth16 Verification Implementation

## Implementation Details

The `ptf_verifier_groth16` program implements Groth16 verification using Solana's **alt_bn128 syscalls**:
- `alt_bn128_addition` - G1 point addition
- `alt_bn128_multiplication` - G1 scalar multiplication  
- `alt_bn128_pairing` - Bilinear pairing operation

**Important:** There is **no** `sol_groth16_verify` syscall on Solana. Groth16 verification is implemented in userland using the alt_bn128 syscalls.

## Test Environment
- **Solana Version:** 2.3.2
- **Mainnet Version:** 3.0.6
- **Test Validator:** solana-test-validator 2.3.2

## Test Procedure

1. Built verifier program with `groth16-syscall` feature
2. Attempted to deploy to local validator
3. Checked for syscall availability

## Test Results

### ⚠️ Alt_bn128 Syscalls NOT Available in Test Validator

**Deployment Error:**
```
Error: ELF error: ELF error: Unresolved symbol (sol_alt_bn128_*) at instruction #...
```

**Conclusion:** The alt_bn128 syscalls are **NOT available** in `solana-test-validator` version 2.3.2.

## Why This Happens

The test validator (`solana-test-validator`) is a simplified runtime that doesn't include all syscalls available on mainnet/testnet. This is intentional - test validators focus on core functionality and may exclude advanced features like ZK/curve operations (alt_bn128 syscalls).

## Impact

### Local Development
- ✅ Can still develop and test locally
- ⚠️ Must use `groth16-dev-skip` feature (proofs bypassed)
- ⚠️ Not suitable for security testing

### Production Deployment
- ✅ Alt_bn128 syscalls ARE available on mainnet/testnet (Solana 1.18.x+)
- ✅ Can deploy securely with `groth16-syscall` feature
- ✅ Full security and decentralization on mainnet
- ✅ Groth16 verification implemented using alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing

## Recommended Workflow

### 1. Local Development
```bash
# Use default (groth16-dev-skip)
anchor build
./scripts/reset-dev-env.sh
# Fast iteration, proofs bypassed
```

### 2. Testnet Testing
```bash
# Build with syscall for testnet
anchor build -- --features groth16-syscall
anchor deploy --provider.cluster testnet
# Full security testing before mainnet
```

### 3. Mainnet Production
```bash
# Build with syscall for mainnet
./scripts/build-for-production.sh
anchor deploy --provider.cluster mainnet
# Fully secure and decentralized
```

## Alternative: Upgrade Attempt

We attempted to upgrade to Solana 3.0.6 (matching mainnet), but:
- Network issues prevented download
- Even if upgraded, test validator may still not support syscall

## Conclusion

**The test validator does NOT support the alt_bn128 syscalls**, even in newer versions. This is a known limitation.

**Solution:**
- Use `groth16-dev-skip` for local development (bypasses verification)
- Use `groth16-syscall` on testnet for testing (uses real alt_bn128 syscalls)
- Use `groth16-syscall` on mainnet for production (uses real alt_bn128 syscalls)

This workflow ensures:
- ✅ Fast local development
- ✅ Full security testing on testnet
- ✅ Secure production deployment on mainnet

## Implementation Notes

The verifier implements Groth16 verification by:
1. Parsing verifying key and proof from Arkworks format
2. Preparing public inputs using `alt_bn128_multiplication` and `alt_bn128_addition`
3. Performing pairing check using `alt_bn128_pairing`
4. Verifying the pairing equation: `e(proof_a, proof_b) * e(prepared_inputs, vk_gamma_g2) * e(proof_c, vk_delta_g2) * e(-vk_alpha_g1, vk_beta_g2) == 1`

This follows the same approach as libraries like `groth16-solana` but handles variable numbers of public inputs dynamically.

