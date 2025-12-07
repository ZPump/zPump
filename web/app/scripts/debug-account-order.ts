import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { derivePoolState, deriveMintMapping, deriveNullifierSet, deriveNoteLedger, deriveCommitmentTree, deriveHookConfig, deriveHookWhitelist, deriveVaultState, deriveFactoryState, deriveVerifyingKey } from '../lib/onchain/pdas';
import { POOL_PROGRAM_ID, VERIFIER_PROGRAM_ID, FACTORY_PROGRAM_ID, VAULT_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../lib/onchain/programIds';
import { SystemProgram } from '@solana/web3.js';
import poolIdl from '../idl/ptf_pool.json';
import { BorshCoder, Idl } from '@coral-xyz/anchor';

async function debug() {
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const walletPubkey = new PublicKey('11111111111111111111111111111111'); // Dummy for testing
  
  const poolCoder = new BorshCoder(poolIdl as Idl);
  const poolState = derivePoolState(wsolMint);
  const nullifierSet = deriveNullifierSet(wsolMint);
  const noteLedger = deriveNoteLedger(wsolMint);
  const commitmentTree = deriveCommitmentTree(wsolMint);
  const hookConfig = deriveHookConfig(wsolMint);
  const hookWhitelist = deriveHookWhitelist(wsolMint);
  const vaultState = deriveVaultState(wsolMint);
  const mintMapping = deriveMintMapping(wsolMint);
  const factoryState = deriveFactoryState();
  const verifyingKey = deriveVerifyingKey();
  
  const poolAccounts: Record<string, PublicKey> = {
    authority: walletPubkey,
    pool_state: poolState,
    nullifier_set: nullifierSet,
    note_ledger: noteLedger,
    commitment_tree: commitmentTree,
    hook_config: hookConfig,
    hook_whitelist: hookWhitelist,
    vault_state: vaultState,
    origin_mint: wsolMint,
    mint_mapping: mintMapping,
    factory_state: factoryState,
    twin_mint: POOL_PROGRAM_ID,
    verifier_program: VERIFIER_PROGRAM_ID,
    verifying_key: verifyingKey,
    payer: walletPubkey,
    system_program: SystemProgram.programId,
    token_program: TOKEN_PROGRAM_ID
  };
  
  const ixDef = (poolIdl as Idl).instructions?.find((item) => item.name === 'initialize_pool');
  if (!ixDef) {
    console.error('initialize_pool not found');
    return;
  }
  
  console.log('Account order in instruction:');
  const accounts = ixDef.accounts || [];
  accounts.forEach((acc, i) => {
    const name = acc.name;
    const pubkey = poolAccounts[name];
    console.log(`  ${i}: ${name} = ${pubkey?.toBase58() || 'MISSING'}`);
  });
  
  console.log(`\norigin_mint (position ${accounts.findIndex(a => a.name === 'origin_mint')}): ${wsolMint.toBase58()}`);
  console.log(`mint_mapping (position ${accounts.findIndex(a => a.name === 'mint_mapping')}): ${mintMapping.toBase58()}`);
}

debug().catch(console.error);
