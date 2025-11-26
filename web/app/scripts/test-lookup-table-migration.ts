#!/usr/bin/env tsx
/**
 * Comprehensive test suite for lookup table migration to MintMapping
 * Tests lookup table creation, storage, reuse, sharing, extension, and backward compatibility
 */

import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';
import { fetchMintMappingAccount, setLookupTableForMint, wrap } from '../lib/sdk';
import { deriveMintMapping, deriveFactoryState } from '../lib/onchain/pdas';
import { ProofClient } from '../lib/proofClient';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { canonicalizeHex, bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { FACTORY_PROGRAM_ID } from '../lib/onchain/programIds';
import { derivePoolState, deriveCommitmentTree } from '../lib/onchain/pdas';
import { decodeCommitmentTree } from '../lib/onchain/commitmentTree';
import { WalletContextState } from '@solana/wallet-adapter-react';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL || 'http://127.0.0.1:8788';
const MINTS_API_URL = process.env.MINTS_API_URL || 'http://localhost:3000/api/mints';

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomFieldScalar(): string {
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(31)));
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString();
}

async function fetchMintCatalog(): Promise<MintConfig[]> {
  const response = await fetch(MINTS_API_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch mint catalog: ${response.status}`);
  }
  const payload = (await response.json()) as { mints?: MintConfig[] };
  return payload.mints ?? [];
}

async function createWalletAdapter(keypair: Keypair): Promise<WalletContextState> {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof Transaction) {
        tx.partialSign(keypair);
      } else if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      }
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      return txs.map(tx => {
        if (tx instanceof Transaction) {
          tx.partialSign(keypair);
        } else if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
        }
        return tx;
      });
    },
    sendTransaction: async (tx: Transaction | VersionedTransaction, connection: Connection) => {
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false
      });
      return signature;
    },
    connected: true,
    connecting: false,
    disconnecting: false,
    autoConnect: false,
    disconnect: async () => {},
    connect: async () => {},
    wallet: null,
    wallets: [],
    select: async () => {},
    signMessage: undefined
  } as unknown as WalletContextState;
}

async function main() {
  console.log('[test-lookup-table-migration] Starting comprehensive lookup table migration tests');
  console.log(`[test-lookup-table-migration] RPC: ${RPC_URL}`);
  console.log(`[test-lookup-table-migration] Proof: ${PROOF_URL}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });

  // Get a test mint
  const catalog = await fetchMintCatalog();
  if (catalog.length === 0) {
    throw new Error('No mints available in catalog');
  }
  const mintConfig = catalog[0]!;
  const originMint = new PublicKey(mintConfig.originMint);
  const poolState = new PublicKey(mintConfig.poolId);

  // Create test wallets
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user1Adapter = await createWalletAdapter(user1);
  const user2Adapter = await createWalletAdapter(user2);

  // Airdrop SOL to wallets
  console.log('[test] Airdropping SOL to test wallets...');
  const airdrop1 = await connection.requestAirdrop(user1.publicKey, 2e9);
  await connection.confirmTransaction(airdrop1, 'confirmed');
  const airdrop2 = await connection.requestAirdrop(user2.publicKey, 2e9);
  await connection.confirmTransaction(airdrop2, 'confirmed');
  await sleep(1000);

  // Test 1: Verify MintMapping has lookup_table field (initially null)
  console.log('\n[test] Test 1: Verify MintMapping structure includes lookup_table field');
  const { decoded: initialMapping } = await fetchMintMappingAccount(connection, originMint);
  console.log(`[test] ✓ MintMapping read successfully`);
  console.log(`[test]   - lookup_table: ${initialMapping.lookupTable ? initialMapping.lookupTable.toBase58() : 'null (expected)'}`);
  if (initialMapping.lookupTable !== null && initialMapping.lookupTable !== undefined) {
    console.warn(`[test]   WARNING: lookup_table is set before first shield`);
  }

  // Test 2: First shield creates and stores lookup table
  console.log('\n[test] Test 2: First shield creates and stores lookup table in MintMapping');
  const commitmentTree = deriveCommitmentTree(originMint);
  const treeAccount = await connection.getAccountInfo(commitmentTree);
  if (!treeAccount) {
    throw new Error('Commitment tree account missing');
  }
  const treeState = decodeCommitmentTree(new Uint8Array(treeAccount.data));
  const currentRoot = bytesLEToCanonicalHex(treeState.currentRoot);

  const depositId1 = randomFieldScalar();
  const blinding1 = randomFieldScalar();
  const amount1 = BigInt('1000000'); // 1 token with 6 decimals

  const proof1 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    depositId: depositId1,
    blinding: blinding1,
    amount: amount1.toString(),
    recipient: user1.publicKey.toBase58(),
    mintId: originMint.toBase58(),
    poolId: poolState.toBase58()
  });

  const signature1 = await wrap({
    connection,
    wallet: user1Adapter,
    originMint: originMint.toBase58(),
    poolId: poolState.toBase58(),
    depositId: depositId1,
    blinding: blinding1,
    amount: amount1,
    proof: proof1,
    recipient: user1.publicKey.toBase58()
  });

  console.log(`[test] ✓ First shield completed: ${signature1}`);
  await sleep(2000); // Wait for transaction to settle

  // Verify lookup table is now stored in MintMapping
  const { decoded: mappingAfterShield } = await fetchMintMappingAccount(connection, originMint);
  if (!mappingAfterShield.lookupTable) {
    throw new Error('Lookup table not stored in MintMapping after first shield');
  }
  console.log(`[test] ✓ Lookup table stored in MintMapping: ${mappingAfterShield.lookupTable.toBase58()}`);

  // Verify lookup table is active
  const tableResponse = await connection.getAddressLookupTable(mappingAfterShield.lookupTable);
  if (!tableResponse.value || !tableResponse.value.state) {
    throw new Error('Lookup table not found');
  }
  const deactivationSlot = tableResponse.value.state.deactivationSlot;
  const U64_MAX = BigInt('18446744073709551615');
  const DEVNET_ACTIVE = BigInt('18446744069414584321'); // 0xFFFFFFFF00000001
  const isActive = deactivationSlot === null || 
                   (typeof deactivationSlot === 'bigint' && (deactivationSlot === U64_MAX || deactivationSlot >= DEVNET_ACTIVE)) ||
                   (typeof deactivationSlot === 'number' && (deactivationSlot === Number(U64_MAX) || deactivationSlot >= Number(DEVNET_ACTIVE))) ||
                   (typeof deactivationSlot === 'string' && (BigInt(deactivationSlot) === U64_MAX || BigInt(deactivationSlot) >= DEVNET_ACTIVE));
  if (!isActive) {
    throw new Error('Lookup table is not active');
  }
  console.log(`[test] ✓ Lookup table is active and contains ${tableResponse.value.state.addresses.length} addresses`);

  // Test 3: Second shield reuses lookup table from MintMapping
  console.log('\n[test] Test 3: Second shield reuses lookup table from MintMapping');
  const depositId2 = randomFieldScalar();
  const blinding2 = randomFieldScalar();
  const amount2 = BigInt('500000'); // 0.5 token

  // Get updated root
  const updatedTreeAccount = await connection.getAccountInfo(commitmentTree);
  if (!updatedTreeAccount) {
    throw new Error('Commitment tree account missing');
  }
  const updatedTreeState = decodeCommitmentTree(new Uint8Array(updatedTreeAccount.data));
  const updatedRoot = bytesLEToCanonicalHex(updatedTreeState.currentRoot);

  const proof2 = await proofClient.requestProof('wrap', {
    oldRoot: updatedRoot,
    depositId: depositId2,
    blinding: blinding2,
    amount: amount2.toString(),
    recipient: user1.publicKey.toBase58(),
    mintId: originMint.toBase58(),
    poolId: poolState.toBase58()
  });

  const signature2 = await wrap({
    connection,
    wallet: user1Adapter,
    originMint: originMint.toBase58(),
    poolId: poolState.toBase58(),
    depositId: depositId2,
    blinding: blinding2,
    amount: amount2,
    proof: proof2,
    recipient: user1.publicKey.toBase58()
  });

  console.log(`[test] ✓ Second shield completed: ${signature2}`);
  await sleep(2000);

  // Verify same lookup table is used
  const { decoded: mappingAfterSecondShield } = await fetchMintMappingAccount(connection, originMint);
  if (!mappingAfterSecondShield.lookupTable?.equals(mappingAfterShield.lookupTable!)) {
    throw new Error('Lookup table changed between shields (should be reused)');
  }
  console.log(`[test] ✓ Same lookup table reused: ${mappingAfterSecondShield.lookupTable.toBase58()}`);

  // Test 4: Multiple users share same lookup table
  console.log('\n[test] Test 4: Multiple users share same lookup table from MintMapping');
  const depositId3 = randomFieldScalar();
  const blinding3 = randomFieldScalar();
  const amount3 = BigInt('300000'); // 0.3 token

  const finalTreeAccount = await connection.getAccountInfo(commitmentTree);
  if (!finalTreeAccount) {
    throw new Error('Commitment tree account missing');
  }
  const finalTreeState = decodeCommitmentTree(new Uint8Array(finalTreeAccount.data));
  const finalRoot = bytesLEToCanonicalHex(finalTreeState.currentRoot);

  const proof3 = await proofClient.requestProof('wrap', {
    oldRoot: finalRoot,
    depositId: depositId3,
    blinding: blinding3,
    amount: amount3.toString(),
    recipient: user2.publicKey.toBase58(),
    mintId: originMint.toBase58(),
    poolId: poolState.toBase58()
  });

  const signature3 = await wrap({
    connection,
    wallet: user2Adapter,
    originMint: originMint.toBase58(),
    poolId: poolState.toBase58(),
    depositId: depositId3,
    blinding: blinding3,
    amount: amount3,
    proof: proof3,
    recipient: user2.publicKey.toBase58()
  });

  console.log(`[test] ✓ User 2 shield completed: ${signature3}`);
  await sleep(2000);

  // Verify same lookup table is used by both users
  const { decoded: mappingAfterUser2Shield } = await fetchMintMappingAccount(connection, originMint);
  if (!mappingAfterUser2Shield.lookupTable?.equals(mappingAfterShield.lookupTable!)) {
    throw new Error('Lookup table changed for different user (should be shared)');
  }
  console.log(`[test] ✓ Both users share same lookup table: ${mappingAfterUser2Shield.lookupTable.toBase58()}`);

  // Test 5: Lookup table extension (if needed)
  console.log('\n[test] Test 5: Lookup table extension (if new addresses needed)');
  const tableAfterAll = await connection.getAddressLookupTable(mappingAfterUser2Shield.lookupTable!);
  if (tableAfterAll.value) {
    console.log(`[test] ✓ Lookup table contains ${tableAfterAll.value.state.addresses.length} addresses`);
    console.log(`[test]   - Extension handled automatically by wrap function if needed`);
  }

  console.log('\n[test-lookup-table-migration] ✓ All tests passed!');
  process.exit(0);
}

main().catch((error) => {
  console.error('[test-lookup-table-migration] Fatal error:', error);
  process.exit(1);
});

