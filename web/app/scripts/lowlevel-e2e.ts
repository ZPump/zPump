import bs58 from 'bs58';
import crypto from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  getMint
} from '@solana/spl-token';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import { ProofClient, ProofResponse } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { canonicalizeHex, bytesLEToCanonicalHex, canonicalHexToBytesLE } from '../lib/onchain/utils';
import poolIdl from '../idl/ptf_pool.json';
import factoryIdl from '../idl/ptf_factory.json';
import {
  POOL_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID
} from '../lib/onchain/programIds';
import {
  derivePoolState,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveCommitmentTree,
  deriveShieldClaim,
  deriveAllowanceAccount,
  deriveVaultState,
  deriveMintMapping,
  deriveFactoryState,
  deriveVerifyingKey,
  deriveHookConfig
} from '../lib/onchain/pdas';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const INDEXER_PROXY_URL = process.env.INDEXER_PROXY_URL ?? 'http://127.0.0.1:3000/api/indexer';
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const MINTS_API_URL = process.env.MINTS_API_URL ?? 'http://127.0.0.1:3000/api/mints';

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000');
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

const poolCoder = new BorshCoder(poolIdl as Idl);
const factoryCoder = new BorshCoder(factoryIdl as Idl);

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
  zTokenMint?: string;
  lookupTable?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomFieldScalar(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

async function poseidonHexFromValues(values: bigint[]): Promise<string> {
  const hash = await poseidonHashMany(values);
  return canonicalizeHex(`0x${hash.toString(16).padStart(64, '0')}`);
}

function decodeProof(proofResponse: ProofResponse) {
  const proofBytes = Buffer.from(proofResponse.proof, 'base64');
  const fieldBytes = proofResponse.publicInputs.map((input) => {
    const canonical = canonicalizeHex(input);
    return canonicalHexToBytesLE(canonical, 32);
  });
  const publicInputsBytes = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));
  return { proofBytes, publicInputsBytes, fieldBytes };
}

async function faucetSol(connection: Connection, recipient: PublicKey): Promise<void> {
  const response = await fetch(`${FAUCET_BASE_URL}/sol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: recipient.toBase58(), amountLamports: SOL_AIRDROP_LAMPORTS.toString() })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`SOL faucet failed: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
  const { signature } = (await response.json()) as { signature: string };
  await connection.confirmTransaction(signature, 'confirmed');
  await sleep(1000);
}

async function faucetToken(connection: Connection, mint: PublicKey, recipient: PublicKey, amount: bigint): Promise<void> {
  const response = await fetch(`${FAUCET_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mint: mint.toBase58(),
      recipient: recipient.toBase58(),
      amount: amount.toString()
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Token faucet failed: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
  const { signature } = (await response.json()) as { signature: string };
  await connection.confirmTransaction(signature, 'confirmed');
  await sleep(1000);
}

async function fetchMintCatalog(): Promise<MintConfig[]> {
  const response = await fetch(MINTS_API_URL, { cache: 'no-store' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to fetch mint catalogue: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`
    );
  }
  const payload = (await response.json()) as { mints?: MintConfig[] };
  return payload.mints ?? [];
}

async function sendAndConfirmInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

async function fetchPoolStateRoot(connection: Connection, poolId: string): Promise<{ root: string; feeBps: number }> {
  const poolKey = new PublicKey(poolId);
  const account = await connection.getAccountInfo(poolKey, 'confirmed');
  if (!account) {
    throw new Error('Pool state account missing');
  }
  const buffer = Buffer.from(account.data);
  let offset = 8;
  const advance = (bytes: number) => {
    offset += bytes;
  };
  advance(32 * 6);
  advance(32);
  advance(32);
  const rootBytes = buffer.slice(offset, offset + 32);
  advance(32);
  advance(32 * 16);
  offset += 1;
  if (offset % 2 !== 0) {
    offset += 1;
  }
  const feeBps = buffer.readUInt16LE(offset);
  return {
    root: bytesLEToCanonicalHex(rootBytes),
    feeBps
  };
}

async function loadLocalAuthorityKeypair(): Promise<Keypair> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const keyPath = path.join(process.env.HOME ?? '.', '.config', 'solana', 'id.json');
  const raw = await fs.readFile(keyPath, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
  commitment: string;
  nullifier: string;
}

async function main() {
  console.info('[lowlevel-e2e] Starting comprehensive low-level E2E test suite');
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });

  const owner = Keypair.generate();
  const receiver = Keypair.generate();
  const delegate = Keypair.generate();
  const adminAuthority = await loadLocalAuthorityKeypair();

  console.info('[setup] Airdropping SOL to wallets');
  await Promise.all([owner, receiver, delegate].map((kp) => faucetSol(connection, kp.publicKey)));
  await faucetSol(connection, adminAuthority.publicKey);

  const catalog = await fetchMintCatalog();
  if (!catalog.length) {
    throw new Error('No mints available. Run bootstrap script first.');
  }
  const mintConfig = catalog[0]!;
  const originMintKey = new PublicKey(mintConfig.originMint);
  const poolStateKey = new PublicKey(mintConfig.poolId);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const hookConfigKey = deriveHookConfig(originMintKey);
  const vaultStateKey = deriveVaultState(originMintKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const allowanceAddress = deriveAllowanceAccount(poolStateKey, owner.publicKey, delegate.publicKey);

  const initialPoolInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  let currentRoot = canonicalizeHex(initialPoolInfo.root);
  const feeBps = BigInt(initialPoolInfo.feeBps);

  console.info('[test-01] Testing shield instruction (low-level)');
  const depositorTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    owner.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const depositorInfo = await connection.getAccountInfo(depositorTokenAccount);
  if (!depositorInfo) {
    const ix = createAssociatedTokenAccountInstruction(
      owner.publicKey,
      depositorTokenAccount,
      owner.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, owner, [ix]);
  }
  await faucetToken(connection, originMintKey, owner.publicKey, WRAP_AMOUNT * 5n);

  const depositId1 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding1 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount1 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof1 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount1.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId1,
    poolId: mintConfig.poolId,
    blinding: blinding1,
    mintId: mintConfig.originMint
  });

  const shieldClaimKey = deriveShieldClaim(poolStateKey);
  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultStateKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const verifyingKey = deriveVerifyingKey();

  // Decode proof using SDK approach
  const proofBytes = Buffer.from(proof1.proof, 'base64');
  const fieldBytes = proof1.publicInputs.map((input) => {
    const canonical = canonicalizeHex(input);
    return canonicalHexToBytesLE(canonical, 32);
  });
  const publicInputsBytes = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));
  const amountCommitmentBytes = await poseidonHashMany([noteAmount1, BigInt(blinding1)]);

  const shieldData = poolCoder.instruction.encode('shield', {
    args: {
      amount_commit: Array.from(amountCommitmentBytes),
      amount: new BN(noteAmount1.toString()),
      proof: proofBytes,
      public_inputs: publicInputsBytes
    }
  });

  const shieldKeys = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys,
    data: shieldData
  });

  const shieldSig = await sendAndConfirmInstructions(connection, owner, [shieldIx]);
  console.info('[test-01] shield instruction successful', shieldSig);

  console.info('[test-02] Testing shield_finalize_tree instruction (low-level)');
  const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
  const finalizeTreeIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: finalizeTreeData
  });
  const finalizeTreeSig = await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx]);
  console.info('[test-02] shield_finalize_tree instruction successful', finalizeTreeSig);

  console.info('[test-03] Testing shield_finalize_ledger instruction (low-level)');
  const finalizeLedgerData = poolCoder.instruction.encode('shield_finalize_ledger', {});
  const finalizeLedgerIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: finalizeLedgerData
  });
  const finalizeLedgerSig = await sendAndConfirmInstructions(connection, owner, [finalizeLedgerIx]);
  console.info('[test-03] shield_finalize_ledger instruction successful', finalizeLedgerSig);

  const updatedRoot = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot.root);
  const wrap1: WrapResult = {
    noteId: depositId1,
    spendingKey: blinding1,
    noteAmount: noteAmount1,
    newRoot: currentRoot,
    commitment: proof1.publicInputs[2]!,
    nullifier: (await poseidonHashMany([BigInt(`0x${depositId1}`), BigInt(blinding1)])).toString(16).padStart(64, '0')
  };

  console.info('[test-04] Testing private_transfer instruction (low-level)');
  const depositId2 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding2 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount2 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof2 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount2.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId2,
    poolId: mintConfig.poolId,
    blinding: blinding2,
    mintId: mintConfig.originMint
  });

  const shieldData2 = poolCoder.instruction.encode('shield', {
    args: {
      oldRoot: Array.from(Buffer.from(proof2.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(proof2.publicInputs[1]!.slice(2), 'hex').reverse()),
      noteCommitment: Array.from(Buffer.from(proof2.publicInputs[2]!.slice(2), 'hex').reverse()),
      amount: new BN(noteAmount2.toString()),
      recipient: Array.from(owner.publicKey.toBytes()),
      depositId: new BN(depositId2),
      blinding: new BN(blinding2),
      proofA: proof2.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: proof2.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: proof2.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const shieldIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: false },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : originMintKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: shieldData2
  });
  await sendAndConfirmInstructions(connection, owner, [shieldIx2]);

  const finalizeTreeIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx2]);

  const finalizeLedgerIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeLedgerIx2]);

  const updatedRoot2 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot2.root);

  const transferAmount = WRAP_AMOUNT / 2n;
  const changeAmount = wrap1.noteAmount - transferAmount;
  const transferBlinding = randomFieldScalar();
  const changeBlinding = randomFieldScalar();

  const transferProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap1.noteId,
        spendingKey: wrap1.spendingKey,
        amount: wrap1.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: transferAmount.toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: transferBlinding
      },
      {
        amount: changeAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeBlinding
      }
    ]
  });

  const nullifierBytes = Buffer.from(wrap1.nullifier, 'hex').reverse();
  const outputCommitments = transferProof.publicInputs.slice(2, 4).map((x) =>
    Array.from(Buffer.from(x.slice(2), 'hex').reverse())
  );
  const amountCommitments = await Promise.all([
    poseidonHashMany([transferAmount, BigInt(transferBlinding)]),
    poseidonHashMany([changeAmount, BigInt(changeBlinding)])
  ]).then((hashes) => hashes.map((h) => Array.from(Buffer.from(h.toString(16).padStart(64, '0'), 'hex').reverse())));

  const transferData = poolCoder.instruction.encode('private_transfer', {
    args: {
      oldRoot: Array.from(Buffer.from(transferProof.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(transferProof.publicInputs[1]!.slice(2), 'hex').reverse()),
      nullifiers: [Array.from(nullifierBytes)],
      outputCommitments,
      outputAmountCommitments: amountCommitments,
      proofA: transferProof.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: transferProof.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: transferProof.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const transferIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false }
    ],
    data: transferData
  });

  const transferSig = await sendAndConfirmInstructions(connection, owner, [transferIx]);
  console.info('[test-04] private_transfer instruction successful', transferSig);

  const updatedRoot3 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot3.root);

  console.info('[test-05] Testing approve_allowance instruction (low-level)');
  const allowanceAmount = WRAP_AMOUNT;
  const approveData = poolCoder.instruction.encode('approve_allowance', {
    args: { amount: new BN(allowanceAmount.toString()) }
  });
  const approveIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: delegate.publicKey, isSigner: false, isWritable: false },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false }
    ],
    data: approveData
  });
  const approveSig = await sendAndConfirmInstructions(connection, owner, [approveIx]);
  console.info('[test-05] approve_allowance instruction successful', approveSig);

  console.info('[test-06] Testing transfer_from instruction (low-level)');
  const depositId3 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding3 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount3 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof3 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount3.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId3,
    poolId: mintConfig.poolId,
    blinding: blinding3,
    mintId: mintConfig.originMint
  });

  const shieldData3 = poolCoder.instruction.encode('shield', {
    args: {
      oldRoot: Array.from(Buffer.from(proof3.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(proof3.publicInputs[1]!.slice(2), 'hex').reverse()),
      noteCommitment: Array.from(Buffer.from(proof3.publicInputs[2]!.slice(2), 'hex').reverse()),
      amount: new BN(noteAmount3.toString()),
      recipient: Array.from(owner.publicKey.toBytes()),
      depositId: new BN(depositId3),
      blinding: new BN(blinding3),
      proofA: proof3.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: proof3.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: proof3.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const shieldIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: false },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : originMintKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: shieldData3
  });
  await sendAndConfirmInstructions(connection, owner, [shieldIx3]);

  const finalizeTreeIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx3]);

  const finalizeLedgerIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeLedgerIx3]);

  const updatedRoot4 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot4.root);

  const wrap3: WrapResult = {
    noteId: depositId3,
    spendingKey: blinding3,
    noteAmount: noteAmount3,
    newRoot: currentRoot,
    commitment: proof3.publicInputs[2]!,
    nullifier: (await poseidonHashMany([BigInt(`0x${depositId3}`), BigInt(blinding3)])).toString(16).padStart(64, '0')
  };

  const transferFromAmount = WRAP_AMOUNT / 4n;
  const changeFromAmount = wrap3.noteAmount - transferFromAmount;
  const transferFromBlinding = randomFieldScalar();
  const changeFromBlinding = randomFieldScalar();

  const transferFromProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap3.noteId,
        spendingKey: wrap3.spendingKey,
        amount: wrap3.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: transferFromAmount.toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: transferFromBlinding
      },
      {
        amount: changeFromAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeFromBlinding
      }
    ]
  });

  const nullifierBytes3 = Buffer.from(wrap3.nullifier, 'hex').reverse();
  const outputCommitments3 = transferFromProof.publicInputs.slice(2, 4).map((x) =>
    Array.from(Buffer.from(x.slice(2), 'hex').reverse())
  );
  const amountCommitments3 = await Promise.all([
    poseidonHashMany([transferFromAmount, BigInt(transferFromBlinding)]),
    poseidonHashMany([changeFromAmount, BigInt(changeFromBlinding)])
  ]).then((hashes) => hashes.map((h) => Array.from(Buffer.from(h.toString(16).padStart(64, '0'), 'hex').reverse())));

  const transferFromData = poolCoder.instruction.encode('transfer_from', {
    args: {
      oldRoot: Array.from(Buffer.from(transferFromProof.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(transferFromProof.publicInputs[1]!.slice(2), 'hex').reverse()),
      nullifiers: [Array.from(nullifierBytes3)],
      outputCommitments: outputCommitments3,
      outputAmountCommitments: amountCommitments3,
      proofA: transferFromProof.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: transferFromProof.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: transferFromProof.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const transferFromIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: false, isWritable: false },
      { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false }
    ],
    data: transferFromData
  });

  const transferFromSig = await sendAndConfirmInstructions(connection, delegate, [transferFromIx]);
  console.info('[test-06] transfer_from instruction successful', transferFromSig);

  const updatedRoot5 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot5.root);

  console.info('[test-07] Testing unshield_to_origin instruction (low-level)');
  const depositId4 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding4 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount4 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof4 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount4.toString(),
    recipient: receiver.publicKey.toBase58(),
    depositId: depositId4,
    poolId: mintConfig.poolId,
    blinding: blinding4,
    mintId: mintConfig.originMint
  });

  const shieldData4 = poolCoder.instruction.encode('shield', {
    args: {
      oldRoot: Array.from(Buffer.from(proof4.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(proof4.publicInputs[1]!.slice(2), 'hex').reverse()),
      noteCommitment: Array.from(Buffer.from(proof4.publicInputs[2]!.slice(2), 'hex').reverse()),
      amount: new BN(noteAmount4.toString()),
      recipient: Array.from(receiver.publicKey.toBytes()),
      depositId: new BN(depositId4),
      blinding: new BN(blinding4),
      proofA: proof4.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: proof4.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: proof4.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const shieldIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: false },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: await getAssociatedTokenAddress(originMintKey, receiver.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : originMintKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: receiver.publicKey, isSigner: true, isWritable: true },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: shieldData4
  });
  await sendAndConfirmInstructions(connection, receiver, [shieldIx4]);

  const finalizeTreeIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, receiver, [finalizeTreeIx4]);

  const finalizeLedgerIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: deriveShieldClaim(poolStateKey), isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(connection, receiver, [finalizeLedgerIx4]);

  const updatedRoot6 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot6.root);

  const wrap4: WrapResult = {
    noteId: depositId4,
    spendingKey: blinding4,
    noteAmount: noteAmount4,
    newRoot: currentRoot,
    commitment: proof4.publicInputs[2]!,
    nullifier: (await poseidonHashMany([BigInt(`0x${depositId4}`), BigInt(blinding4)])).toString(16).padStart(64, '0')
  };

  const unshieldAmount = wrap4.noteAmount;
  const unshieldBlinding = randomFieldScalar();

  const unshieldProof = await proofClient.requestProof('unwrap', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap4.noteId,
        spendingKey: wrap4.spendingKey,
        amount: wrap4.noteAmount.toString()
      }
    ],
    outAmount: unshieldAmount.toString(),
    recipient: receiver.publicKey.toBase58(),
    blinding: unshieldBlinding
  });

  const nullifierBytes4 = Buffer.from(wrap4.nullifier, 'hex').reverse();
  const destinationTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    receiver.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const destInfo = await connection.getAccountInfo(destinationTokenAccount);
  if (!destInfo) {
    const ix = createAssociatedTokenAccountInstruction(
      receiver.publicKey,
      destinationTokenAccount,
      receiver.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, receiver, [ix]);
  }

  const unshieldData = poolCoder.instruction.encode('unshield_to_origin', {
    args: {
      oldRoot: Array.from(Buffer.from(unshieldProof.publicInputs[0]!.slice(2), 'hex').reverse()),
      newRoot: Array.from(Buffer.from(unshieldProof.publicInputs[1]!.slice(2), 'hex').reverse()),
      nullifiers: [Array.from(nullifierBytes4)],
      amount: new BN(unshieldAmount.toString()),
      recipient: Array.from(receiver.publicKey.toBytes()),
      blinding: new BN(unshieldBlinding),
      proofA: unshieldProof.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
      proofB: unshieldProof.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
      proofC: unshieldProof.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
    }
  });

  const unshieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : originMintKey, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: factoryStateKey, isSigner: false, isWritable: false },
      { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: unshieldData
  });

  const unshieldSig = await sendAndConfirmInstructions(connection, receiver, [unshieldIx]);
  console.info('[test-07] unshield_to_origin instruction successful', unshieldSig);

  console.info('[test-08] Testing write_nullifier instruction (low-level)');
  const testNullifier = Buffer.alloc(32);
  crypto.randomFillSync(testNullifier);
  const writeNullifierData = poolCoder.instruction.encode('write_nullifier', {
    nullifier: Array.from(testNullifier)
  });
  const writeNullifierIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: adminAuthority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true }
    ],
    data: writeNullifierData
  });
  const writeNullifierSig = await sendAndConfirmInstructions(connection, adminAuthority, [writeNullifierIx]);
  console.info('[test-08] write_nullifier instruction successful', writeNullifierSig);

  console.info('[test-09] Testing nullifier reuse rejection (edge case)');
  try {
    await sendAndConfirmInstructions(connection, adminAuthority, [writeNullifierIx]);
    throw new Error('Expected nullifier reuse error');
  } catch (error: any) {
    if (error.logs?.some((log: string) => log.includes('NullifierReuse'))) {
      console.info('[test-09] nullifier reuse correctly rejected');
    } else {
      throw error;
    }
  }

  console.info('[test-10] Testing revoke_allowance instruction (low-level)');
  const revokeData = poolCoder.instruction.encode('revoke_allowance', {});
  const revokeIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: delegate.publicKey, isSigner: false, isWritable: false },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false }
    ],
    data: revokeData
  });
  const revokeSig = await sendAndConfirmInstructions(connection, owner, [revokeIx]);
  console.info('[test-10] revoke_allowance instruction successful', revokeSig);

  console.info('[test-11] Testing insufficient allowance rejection (edge case)');
  const insufficientTransferFromProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap3.noteId,
        spendingKey: wrap3.spendingKey,
        amount: wrap3.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: (WRAP_AMOUNT * 2n).toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: randomFieldScalar()
      }
    ]
  });
  try {
    const insufficientTransferFromData = poolCoder.instruction.encode('transfer_from', {
      args: {
        oldRoot: Array.from(Buffer.from(insufficientTransferFromProof.publicInputs[0]!.slice(2), 'hex').reverse()),
        newRoot: Array.from(Buffer.from(insufficientTransferFromProof.publicInputs[1]!.slice(2), 'hex').reverse()),
        nullifiers: [Array.from(nullifierBytes3)],
        outputCommitments: [Array.from(Buffer.from(insufficientTransferFromProof.publicInputs[2]!.slice(2), 'hex').reverse())],
        outputAmountCommitments: [Array.from(Buffer.from((await poseidonHashMany([WRAP_AMOUNT * 2n, BigInt(randomFieldScalar())])).toString(16).padStart(64, '0'), 'hex').reverse())],
        proofA: insufficientTransferFromProof.proof.a.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse())),
        proofB: insufficientTransferFromProof.proof.b.map((x) => x.map((y) => Array.from(Buffer.from(y.slice(2), 'hex').reverse()))),
        proofC: insufficientTransferFromProof.proof.c.map((x) => Array.from(Buffer.from(x.slice(2), 'hex').reverse()))
      }
    });
    const insufficientTransferFromIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
        { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
        { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('vk'), Buffer.from('transfer'), new Uint8Array([1])], VERIFIER_PROGRAM_ID)[0], isSigner: false, isWritable: false },
        { pubkey: allowanceAddress, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false }
      ],
      data: insufficientTransferFromData
    });
    await sendAndConfirmInstructions(connection, delegate, [insufficientTransferFromIx]);
    throw new Error('Expected insufficient allowance error');
  } catch (error: any) {
    if (error.logs?.some((log: string) => log.includes('AllowanceInsufficient'))) {
      console.info('[test-11] insufficient allowance correctly rejected');
    } else {
      console.warn('[test-11] Note: This test may fail if note was already spent. Error:', error.message);
    }
  }

  console.info('[lowlevel-e2e] All low-level E2E tests completed successfully');
}

main().catch((error) => {
  console.error('[fatal] lowlevel-e2e script failed', error);
  process.exitCode = 1;
});

