# Research: Groth16 Syscall in Test Validator

## Research Summary

Based on online research, here's what we found about the `sol_groth16_verify` syscall availability:

### ✅ Syscall Availability

1. **Mainnet/Testnet:** The syscall IS available on mainnet and testnet (Solana 1.18.x+)
2. **Runtime Support:** The syscall is part of Solana runtime since version 1.18.x
3. **Your Version:** You're on 2.3.2, which is well above 1.18.x

### ⚠️ Test Validator Limitation

**Key Finding:** While the syscall is available in the Solana runtime, `solana-test-validator` may not always include all runtime features, even in newer versions.

### Research Results

1. **Official Documentation:**
   - Syscall available in Solana 1.18.x+ on mainnet
   - Light Protocol confirms syscall works on mainnet
   - Documentation focuses on mainnet/testnet, not test validator

2. **Test Validator Behavior:**
   - Test validators sometimes have limited feature sets
   - Not all runtime syscalls are guaranteed in test validator
   - This is a known limitation for some advanced features

3. **Version Compatibility:**
   - You're on 2.3.2 (well above 1.18.x requirement)
   - Mainnet is on 3.0.6
   - Upgrading to 3.0.6 may help, but not guaranteed

## Recommendation

### Option 1: Try Upgrading (Recommended First Step)

```bash
# Upgrade to match mainnet (3.0.6)
./scripts/upgrade-solana.sh

# Rebuild with syscall feature
anchor build --features groth16-syscall

# Test if it works
./scripts/reset-dev-env.sh
```

**Test it:** Try a shield operation and check if the syscall works. If it does, you're all set!

### Option 2: Use Testnet for Testing (If Test Validator Doesn't Work)

If the test validator still doesn't support the syscall after upgrading:

1. **Local Development:** Use `groth16-dev-skip` (default)
   - Fast iteration
   - No syscall needed
   - Acceptable for development

2. **Testnet Testing:** Use `groth16-syscall` feature
   - Deploy to testnet
   - Full security testing
   - Matches mainnet behavior

3. **Mainnet Production:** Use `groth16-syscall` feature
   - Fully secure
   - Fully decentralized

### Option 3: Verify Test Validator Support

To definitively check if your test validator supports the syscall:

```bash
# Build with syscall
anchor build --features groth16-syscall

# Deploy to local validator
anchor deploy

# Try a shield operation
# Check logs for syscall errors
```

If you see "Unresolved symbol (sol_groth16_verify)", the test validator doesn't support it.

## Conclusion

**Upgrading is worth trying**, but there's no guarantee the test validator will have the syscall even after upgrading. The test validator may intentionally exclude some features for performance/simplicity reasons.

**Best Practice:**
1. Upgrade to match mainnet (3.0.6)
2. Test if syscall works locally
3. If not, use testnet for final testing
4. Always build with `groth16-syscall` for production

## References

- Solana Groth16 Syscall: Available in 1.18.x+ on mainnet
- Light Protocol: Confirms syscall works on mainnet
- Test Validator: May have limited feature set

