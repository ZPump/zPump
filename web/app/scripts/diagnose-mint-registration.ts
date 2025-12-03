#!/usr/bin/env tsx
/**
 * Diagnostic script to identify which account is causing the 0x0 error
 * This script checks all account states before and after transactions
 */

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const PROGRAM_IDS = {
  factory: new PublicKey('94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK'),
  pool: new PublicKey('ESbKkBQ9P7pavvFPejBXhguBY3BSLtf1LyEQqBNRDHqb'),
  vault: new PublicKey('AuFnb2FWz1W8ozcpSGc9RYbgSaon7bwtB5w9bPJnHkqH'),
  verifier: new PublicKey('2V5XN9rpubXdK3cdWBBjZwjxMpMzQBKTaN3moEJ59a8K')
};

interface AccountDiagnostic {
  name: string;
  address: PublicKey;
  exists: boolean;
  owner: string | null;
  dataLength: number;
  isUninitialized: boolean;
  isSystemOwned: boolean;
  isProgramOwned: boolean;
  expectedOwner: PublicKey | null;
}

async function checkAccount(
  connection: Connection,
  name: string,
  address: PublicKey,
  expectedOwner: PublicKey | null
): Promise<AccountDiagnostic> {
  const info = await connection.getAccountInfo(address);
  const exists = info !== null;
  const owner = info?.owner.toBase58() || null;
  const dataLength = info?.data.length || 0;
  const isSystemOwned = owner === SystemProgram.programId.toBase58();
  const isProgramOwned = expectedOwner ? owner === expectedOwner.toBase58() : false;
  const isUninitialized = exists && !isSystemOwned && !isProgramOwned && owner !== null;

  return {
    name,
    address,
    exists,
    owner,
    dataLength,
    isUninitialized,
    isSystemOwned,
    isProgramOwned,
    expectedOwner
  };
}

async function diagnoseMint(symbol: string, originMint: PublicKey): Promise<void> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Diagnosing mint: ${symbol} (${originMint.toBase58()})`);
  console.log(`${'='.repeat(80)}`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // Derive all PDAs
  const factoryState = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  const mintMapping = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), originMint.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  const vaultState = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), originMint.toBuffer()],
    PROGRAM_IDS.vault
  )[0];
  const poolState = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const nullifierSet = PublicKey.findProgramAddressSync(
    [Buffer.from('nulls'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const noteLedger = PublicKey.findProgramAddressSync(
    [Buffer.from('notes'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const commitmentTree = PublicKey.findProgramAddressSync(
    [Buffer.from('tree'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const hookConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('hooks'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const hookWhitelist = PublicKey.findProgramAddressSync(
    [Buffer.from('hook-whitelist'), originMint.toBuffer()],
    PROGRAM_IDS.pool
  )[0];

  console.log('\n[Factory Accounts]');
  const factoryAccounts = await Promise.all([
    checkAccount(connection, 'factory_state', factoryState, PROGRAM_IDS.factory),
    checkAccount(connection, 'mint_mapping', mintMapping, PROGRAM_IDS.factory)
  ]);
  factoryAccounts.forEach(acc => {
    console.log(`  ${acc.name.padEnd(20)} ${acc.address.toBase58()}`);
    console.log(`    exists: ${acc.exists}, owner: ${acc.owner || 'N/A'}, dataLen: ${acc.dataLength}`);
    console.log(`    uninitialized: ${acc.isUninitialized}, systemOwned: ${acc.isSystemOwned}, programOwned: ${acc.isProgramOwned}`);
    if (acc.isUninitialized) {
      console.log(`    ⚠️  WARNING: Account is uninitialized (owned by ${acc.owner})`);
    }
  });

  console.log('\n[Vault Accounts]');
  const vaultAccounts = await Promise.all([
    checkAccount(connection, 'vault_state', vaultState, PROGRAM_IDS.vault)
  ]);
  vaultAccounts.forEach(acc => {
    console.log(`  ${acc.name.padEnd(20)} ${acc.address.toBase58()}`);
    console.log(`    exists: ${acc.exists}, owner: ${acc.owner || 'N/A'}, dataLen: ${acc.dataLength}`);
    console.log(`    uninitialized: ${acc.isUninitialized}, systemOwned: ${acc.isSystemOwned}, programOwned: ${acc.isProgramOwned}`);
    if (acc.isUninitialized) {
      console.log(`    ⚠️  WARNING: Account is uninitialized (owned by ${acc.owner})`);
    }
  });

  console.log('\n[Pool Accounts - CRITICAL]');
  const poolAccounts = await Promise.all([
    checkAccount(connection, 'pool_state', poolState, PROGRAM_IDS.pool),
    checkAccount(connection, 'nullifier_set', nullifierSet, PROGRAM_IDS.pool),
    checkAccount(connection, 'note_ledger', noteLedger, PROGRAM_IDS.pool),
    checkAccount(connection, 'commitment_tree', commitmentTree, PROGRAM_IDS.pool),
    checkAccount(connection, 'hook_config', hookConfig, PROGRAM_IDS.pool),
    checkAccount(connection, 'hook_whitelist', hookWhitelist, PROGRAM_IDS.pool)
  ]);
  
  let hasUninitialized = false;
  poolAccounts.forEach(acc => {
    const status = acc.isUninitialized ? '❌ UNINITIALIZED' : acc.exists ? '✓ exists' : '○ not exists';
    console.log(`  ${acc.name.padEnd(20)} ${acc.address.toBase58()} [${status}]`);
    console.log(`    exists: ${acc.exists}, owner: ${acc.owner || 'N/A'}, dataLen: ${acc.dataLength}`);
    console.log(`    uninitialized: ${acc.isUninitialized}, systemOwned: ${acc.isSystemOwned}, programOwned: ${acc.isProgramOwned}`);
    
    // CRITICAL: pool_state, hook_config, and hook_whitelist use `init` not `init_if_needed`
    // If they exist but are uninitialized, init will fail with 0x0
    if (acc.isUninitialized) {
      hasUninitialized = true;
      const usesInit = ['pool_state', 'hook_config', 'hook_whitelist'].includes(acc.name);
      if (usesInit) {
        console.log(`    🔴 CRITICAL: ${acc.name} uses 'init' constraint and is uninitialized!`);
        console.log(`       This will cause 0x0 error because init cannot create existing accounts.`);
      } else {
        console.log(`    ⚠️  WARNING: ${acc.name} is uninitialized (uses init_if_needed, should handle it)`);
      }
    }
  });

  if (hasUninitialized) {
    console.log('\n❌ DIAGNOSIS: Found uninitialized pool accounts that will cause 0x0 error');
    console.log('   Solution: Generate a new mint to get fresh PDAs');
  } else {
    console.log('\n✓ DIAGNOSIS: All accounts are in valid states');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: tsx diagnose-mint-registration.ts <symbol> <originMint>');
    process.exit(1);
  }

  const [symbol, originMintStr] = args;
  const originMint = new PublicKey(originMintStr);

  await diagnoseMint(symbol, originMint);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

