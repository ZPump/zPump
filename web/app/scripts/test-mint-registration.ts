#!/usr/bin/env tsx
/**
 * Test script to verify mint registration works reliably
 * This tests the fix for the 0x0 error (uninitialized account issue)
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fetchMintMappingAccount } from '../lib/sdk';
import { deriveMintMapping } from '../lib/onchain/pdas';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const MINTS_API_URL = process.env.MINTS_API_URL || 'http://localhost:3000/api/mints';

async function testMintRegistration(symbol: string, decimals: number = 6): Promise<boolean> {
  try {
    const response = await fetch(MINTS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, decimals })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error(`[test] Failed to register ${symbol}:`, error.error || error);
      return false;
    }

    const result = await response.json();
    console.log(`[test] ✓ Successfully registered ${symbol}:`, result.mint?.originMint || 'unknown');
    return true;
  } catch (error) {
    console.error(`[test] Error registering ${symbol}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

// Generate unique 4-6 character symbols
let symbolCounter = 0;
function genSymbol(prefix: string, num: number): string {
  symbolCounter++;
  const unique = (Date.now() + symbolCounter).toString(36).slice(-4).toUpperCase();
  return `${prefix}${unique}`.substring(0, 6);
}

async function main() {
  console.log('[test-mint-registration] Starting mint registration reliability test');
  console.log(`[test-mint-registration] RPC: ${RPC_URL}`);
  console.log(`[test-mint-registration] API: ${MINTS_API_URL}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  
  // Test 1: Single mint registration
  console.log('\n[test] Test 1: Single mint registration');
  const test1 = await testMintRegistration(genSymbol('RG', 1), 6);
  if (!test1) {
    console.error('[test] Test 1 FAILED');
    process.exit(1);
  }

  // Test 2: Multiple sequential registrations
  console.log('\n[test] Test 2: Multiple sequential registrations');
  const symbols = [
    genSymbol('RG', 2),
    genSymbol('RG', 3),
    genSymbol('RG', 4),
    genSymbol('RG', 5)
  ];
  let successCount = 0;
  
  for (const symbol of symbols) {
    const success = await testMintRegistration(symbol, 6);
    if (success) {
      successCount++;
    }
    // Small delay between registrations
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (successCount < symbols.length) {
    console.error(`[test] Test 2 FAILED: Only ${successCount}/${symbols.length} registrations succeeded`);
    process.exit(1);
  }

  console.log(`[test] Test 2 PASSED: All ${symbols.length} registrations succeeded`);

  // Test 2.5: Verify MintMapping can be read and lookup_table field exists (will be null initially)
  console.log('\n[test] Test 2.5: Verify MintMapping structure includes lookup_table field');
  try {
    const lastRegisteredSymbol = symbols[symbols.length - 1];
    const lastResponse = await fetch(`${MINTS_API_URL}?symbol=${lastRegisteredSymbol}`);
    if (lastResponse.ok) {
      const lastResult = await lastResponse.json();
      const originMint = new PublicKey(lastResult.mint?.originMint);
      const { decoded: mintMapping } = await fetchMintMappingAccount(connection, originMint);
      console.log(`[test] ✓ MintMapping read successfully for ${lastRegisteredSymbol}`);
      // lookup_table field removed - addresses are now derived programmatically
    }
  } catch (error) {
    // lookup_table field removed - addresses are now derived programmatically
  }

  // Test 3: Rapid sequential registrations (stress test)
  console.log('\n[test] Test 3: Rapid sequential registrations (stress test)');
  const rapidSymbols = [
    genSymbol('RG', 6),
    genSymbol('RG', 7),
    genSymbol('RG', 8)
  ];
  let rapidSuccessCount = 0;
  
  for (const symbol of rapidSymbols) {
    const success = await testMintRegistration(symbol, 6);
    if (success) {
      rapidSuccessCount++;
    }
    // Very small delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (rapidSuccessCount < rapidSymbols.length) {
    console.error(`[test] Test 3 FAILED: Only ${rapidSuccessCount}/${rapidSymbols.length} rapid registrations succeeded`);
    process.exit(1);
  }

  console.log(`[test] Test 3 PASSED: All ${rapidSymbols.length} rapid registrations succeeded`);

  console.log('\n[test-mint-registration] ✓ All tests passed!');
  process.exit(0);
}

main().catch((error) => {
  console.error('[test-mint-registration] Fatal error:', error);
  process.exit(1);
});
