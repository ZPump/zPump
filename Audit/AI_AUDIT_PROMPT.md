# Security Audit Prompt for AI Assistant

## Your Task

You are tasked with performing a **comprehensive security audit** of the zPump smart contract codebase. This is a privacy-preserving token protocol built on Solana using zero-knowledge proofs.

## Audit Scope

You must audit **ALL smart contracts** in the `programs/` directory:

1. **ptf_pool** (`programs/pool/src/lib.rs`) - Main pool program
   - Shield, unshield, private transfer operations
   - Nullifier set management
   - Commitment tree management
   - Fee handling
   - Authority management
   - Hook system

2. **ptf_factory** (`programs/factory/src/lib.rs`) - Factory program
   - Mint registration
   - Verifying key management
   - Timelock action system
   - Authority management

3. **ptf_vault** (`programs/vault/src/lib.rs`) - Vault program
   - Token deposits
   - Token releases
   - Authority management
   - Reentrancy protection

4. **ptf_verifier_groth16** (`programs/verifier-groth16/src/lib.rs`) - Verifier program
   - Verifying key registration
   - Groth16 proof verification

5. **ptf_common** (`programs/common/src/`) - Shared security modules
   - Input validation
   - Account validation
   - Access control
   - Rate limiting

## What to Look For

### Critical Security Issues
- Access control bypasses
- Reentrancy vulnerabilities
- Arithmetic overflow/underflow
- Missing input validation
- State corruption risks
- Double-spending vulnerabilities
- Missing authorization checks
- Logic errors that could lead to fund loss

### High Severity Issues
- Insufficient validation
- Race conditions
- Timelock bypasses
- Root manipulation risks
- Nullifier reuse vulnerabilities
- Fee calculation errors
- Balance validation gaps

### Medium Severity Issues
- Edge cases not handled
- Missing bounds checks
- Inefficient but secure operations
- Information leakage
- Missing error handling

### Low Severity Issues
- Code quality issues
- Minor optimization opportunities
- Documentation gaps
- Type safety improvements

## Audit Folder Structure

The audit findings should be organized in the following structure:

```
Audit/
├── ptf_pool/
│   ├── critical/
│   ├── high/
│   ├── medium/
│   └── low/
├── ptf_factory/
│   ├── critical/
│   ├── high/
│   ├── medium/
│   └── low/
├── ptf_vault/
│   ├── critical/
│   ├── high/
│   ├── medium/
│   └── low/
├── ptf_verifier_groth16/
│   ├── critical/
│   ├── high/
│   ├── medium/
│   └── low/
└── ptf_common/
    ├── critical/
    ├── high/
    ├── medium/
    └── low/
```

## How to Document Findings

For each security issue you find, create a markdown file in the appropriate folder:

**File naming**: Use kebab-case descriptive names, e.g.:
- `missing-balance-check.md`
- `nullifier-reuse-vulnerability.md`
- `arithmetic-overflow-risk.md`

**File format**: Each markdown file should follow this template:

```markdown
# [Issue Title]

**Status:** ⚠️ NEW ISSUE

**Severity:** [CRITICAL | HIGH | MEDIUM | LOW]

**Location:** `[file path]:[line number]` (function name)

## Description

[Detailed description of the security issue]

## Code Reference

### [Function/Code Section Name] (line X-Y):
```rust
// Relevant code snippet
```

## Issue

[Explain the vulnerability, how it could be exploited, and what the impact is]

## Impact

- **Attack scenario**: [How an attacker could exploit this]
- **Potential loss**: [What could be lost or compromised]
- **Likelihood**: [High | Medium | Low]

## Attack Scenario

1. [Step-by-step attack description]
2. [What the attacker needs]
3. [What happens if successful]

## Current Mitigations

[If any mitigations exist, describe them]

## Recommendation

[Detailed recommendation for fixing the issue]

### Suggested Fix:
```rust
// Code showing the fix
```

## Related Code

- `[file path]:[line number]` - [Description]
- `[file path]:[line number]` - [Description]
```

## Important Notes

1. **Read the actual code** - Don't just check the audit folder. Read the smart contract source files directly.

2. **Be thorough** - Look for:
   - Missing validation
   - Incorrect order of operations
   - State consistency issues
   - Access control gaps
   - Arithmetic errors
   - Logic bugs

3. **Check existing audits** - Review `Audit/README.md` and existing audit files to understand what's already been found. Don't duplicate existing findings unless you find a new angle or the issue wasn't fully addressed.

4. **Focus on security** - This is a security audit, not a code review. Focus on vulnerabilities that could lead to:
   - Fund loss
   - Unauthorized access
   - State corruption
   - Double-spending
   - Reentrancy attacks

5. **Be specific** - Include exact file paths, line numbers, and code snippets. Show the actual vulnerable code.

6. **Provide fixes** - For each issue, suggest a concrete fix with code examples.

## Areas of Special Concern

Pay extra attention to:

1. **Balance validation** - Are balances checked before transfers?
2. **Nullifier handling** - Can nullifiers be reused? Is insertion order correct?
3. **Root validation** - Are roots validated correctly? Can they be manipulated?
4. **Proof verification** - Does proof verification happen before state changes?
5. **Reentrancy** - Are there reentrancy vulnerabilities?
6. **Access control** - Are authorization checks sufficient?
7. **Arithmetic** - Are all arithmetic operations safe from overflow/underflow?
8. **State consistency** - Can state become inconsistent?
9. **Timelock bypasses** - Can timelock mechanisms be bypassed?
10. **Fee calculation** - Are fees calculated correctly? Can they be manipulated?

## Example Audit Process

1. **Start with instruction handlers** - Read each public function in each program
2. **Trace state changes** - Follow how state is modified
3. **Check validation** - Verify all inputs are validated
4. **Verify authorization** - Ensure proper access control
5. **Check arithmetic** - Look for overflow/underflow risks
6. **Review order of operations** - Ensure operations happen in correct order
7. **Look for edge cases** - Consider what happens at boundaries
8. **Check for race conditions** - Look for concurrent access issues

## Output

After completing your audit:

1. Create markdown files for each issue found in the appropriate severity folder
2. Update `Audit/README.md` with a summary of findings
3. Create or update `Audit/REMAINING_ISSUES.md` listing all new issues

## Questions to Ask Yourself

For each function you review, ask:

- ✅ Are all inputs validated?
- ✅ Is authorization checked?
- ✅ Are balances checked before transfers?
- ✅ Can state become inconsistent?
- ✅ Are arithmetic operations safe?
- ✅ Can this be re-entered?
- ✅ Are there edge cases not handled?
- ✅ Can an attacker manipulate this?
- ✅ What happens if this fails partway through?
- ✅ Is the order of operations correct?

## Good Luck!

Be thorough, be critical, and find those vulnerabilities! The security of user funds depends on it.

