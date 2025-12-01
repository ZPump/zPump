# Batch TransferFrom - Testing Plan

## Current Status

### ✅ Implementation Complete
- Circuit compiled and verification keys generated
- Proof RPC support added
- Program instruction implemented
- IDL updated
- SDK functions added
- Test file created (structure in place)

### ⏳ Testing Phase

## Test Files to Run

1. **`web/app/scripts/batch-transfer-from-e2e.ts`** - Dedicated batch transferFrom tests
   - Test 1: Basic batch transferFrom with 2 tokens ✅ (implemented)
   - Test 2: Batch transferFrom with change ✅ (implemented)
   - Test 3: Error case - insufficient allowance ✅ (implemented)

2. **Add to existing test files:**
   - `web/app/scripts/comprehensive-e2e.ts` - Add batch transferFrom test case
   - `web/app/scripts/lowlevel-e2e.ts` - Add batch_transfer_from instruction test
   - `web/app/scripts/browser-e2e.ts` - Add browser-style batch transferFrom test

## Test Execution Order

1. Run dedicated batch-transfer-from-e2e.ts test first
2. Fix any issues found
3. Add tests to existing test files
4. Run all tests and fix issues iteratively
5. Continue test/fix/test cycle until all pass

## Known Issues to Watch For

1. **Note ownership in transferFrom**: Owner provides notes to spender (out-of-band in real world)
2. **Change goes back to owner**: Not spender in transferFrom scenarios
3. **Allowance validation**: Must happen before transfers execute
4. **Circuit expects exactly 2 outputs**: Always pad to 2 if needed

## Next Steps

1. Run batch-transfer-from-e2e.ts test
2. Fix any runtime errors
3. Add to existing test files
4. Run full test suite
5. Fix/fix/test until all pass

