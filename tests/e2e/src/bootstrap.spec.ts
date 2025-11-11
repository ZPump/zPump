import { test, expect } from '@playwright/test';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setTimeout as delay } from 'timers/promises';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { BorshCoder, BN, Idl } from '@coral-xyz/anchor';
import poolIdl from '../../../web/app/idl/ptf_pool.json';
import { bootstrapPrivateDevnet } from '../../../web/app/scripts/bootstrap-private-devnet';
import {
  decodeCommitmentTree,
  computeNextCommitmentTreeState
} from '../../../web/app/lib/onchain/commitmentTree';
import { poseidonHashMany } from '../../../web/app/lib/onchain/poseidon';
import {
  deriveCommitmentTree,
  deriveHookConfig,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveVaultState,
  deriveMintMapping,
  deriveFactoryState
} from '../../../web/app/lib/onchain/pdas';
import {
  FACTORY_PROGRAM_ID,
  POOL_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '../../../web/app/lib/onchain/programIds';
import { bytesToBigIntLE } from '../../../web/app/lib/onchain/utils';

const validatorTimeoutMs = 60_000;
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const defaultMintsPath = path.join(repoRoot, 'web', 'app', 'config', 'mints.generated.json');

async function waitForValidator(connection: Connection): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < validatorTimeoutMs) {
    try {
      await connection.getLatestBlockhash('confirmed');
      return;
    } catch (error) {
      await delay(500);
    }
  }
  throw new Error('validator did not become ready within timeout');
}

async function sendInstructions(
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash });
  for (const ix of instructions) {
    transaction.add(ix);
  }
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

async function requestAirdrop(connection: Connection, recipient: PublicKey, lamports: number): Promise<void> {
  const signature = await connection.requestAirdrop(recipient, lamports);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
}

async function getTokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  const balance = await connection.getTokenAccountBalance(account, 'confirmed');
  return BigInt(balance.value.amount);
}

function toBytes32(source: Uint8Array | Buffer): Uint8Array {
  if (source.length === 32) {
    return new Uint8Array(source);
  }
  const buffer = Buffer.alloc(32);
  Buffer.from(source).copy(buffer, 0, 0, Math.min(32, source.length));
  return new Uint8Array(buffer);
}

function u64ToBytes32LE(value: bigint): Uint8Array {
  const buffer = Buffer.alloc(32);
  buffer.writeBigUInt64LE(value);
  return new Uint8Array(buffer);
}

function readU128LE(data: Buffer, offset: number): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) + low;
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

test.describe.serial('private devnet bootstrap', () => {
  let validator: ChildProcessWithoutNullStreams | null = null;
  let connection: Connection;
  let payer: Keypair;
  let tempHome: string;
  let ledgerDir: string;
  let mintsPath: string;
  let originalEnv: { HOME?: string; RPC_URL?: string; MINTS_PATH?: string };

  test.beforeAll(async () => {
    originalEnv = { HOME: process.env.HOME, RPC_URL: process.env.RPC_URL, MINTS_PATH: process.env.MINTS_PATH };

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zpump-home-'));
    ledgerDir = path.join(tempHome, 'ledger');
    await fs.mkdir(path.join(tempHome, '.config', 'solana'), { recursive: true });

    payer = Keypair.generate();
    await fs.writeFile(
      path.join(tempHome, '.config', 'solana', 'id.json'),
      JSON.stringify(Array.from(payer.secretKey))
    );

    const defaultMints = await fs.readFile(defaultMintsPath, 'utf8');
    mintsPath = path.join(tempHome, 'mints.generated.json');
    await fs.writeFile(mintsPath, defaultMints);

    validator = spawn('bash', ['scripts/start-private-devnet.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        LEDGER_DIR: ledgerDir,
        RPC_PORT: '8899',
        FAUCET_PORT: '8898'
      },
      stdio: 'inherit'
    });

    connection = new Connection('http://127.0.0.1:8899', 'confirmed');
    await waitForValidator(connection);
    await requestAirdrop(connection, payer.publicKey, 20 * LAMPORTS_PER_SOL);

    process.env.HOME = tempHome;
    process.env.RPC_URL = 'http://127.0.0.1:8899';
    process.env.MINTS_PATH = mintsPath;

    await bootstrapPrivateDevnet();
  });

  test.afterAll(async () => {
    process.env.HOME = originalEnv.HOME;
    process.env.RPC_URL = originalEnv.RPC_URL;
    process.env.MINTS_PATH = originalEnv.MINTS_PATH;

    if (validator) {
      validator.kill('SIGINT');
      try {
        await once(validator, 'exit');
      } catch {
        /* noop */
      }
    }
  });

  test('shield to unshield maintains vault and ledger invariants', async () => {
    const mintCatalog = JSON.parse(await fs.readFile(mintsPath, 'utf8')) as Array<{
      originMint: string;
      poolId: string;
      decimals: number;
    }>;
    expect(mintCatalog.length).toBeGreaterThan(0);

    const mintConfig = mintCatalog[0];
    const originMint = new PublicKey(mintConfig.originMint);
    const poolStateKey = new PublicKey(mintConfig.poolId);

    const vaultStateKey = deriveVaultState(originMint);
    const commitmentTreeKey = deriveCommitmentTree(originMint);
    const noteLedgerKey = deriveNoteLedger(originMint);
    const nullifierSetKey = deriveNullifierSet(originMint);
    const hookConfigKey = deriveHookConfig(originMint);
    const mintMappingKey = deriveMintMapping(originMint);
    const factoryStateKey = deriveFactoryState();

    const poolCoder = new BorshCoder(poolIdl as Idl);

    const poolAccount = await connection.getAccountInfo(poolStateKey, 'confirmed');
    expect(poolAccount).not.toBeNull();
    const poolState = poolCoder.accounts.decode('PoolState', poolAccount!.data) as any;
    const verifyingKey = new PublicKey(poolState.verifyingKey);
    const feeBps: number = poolState.feeBps instanceof BN ? poolState.feeBps.toNumber() : poolState.feeBps;

    const vaultTokenAccount = await getAssociatedTokenAddress(
      originMint,
      vaultStateKey,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const destinationTokenAccount = await getAssociatedTokenAddress(
      originMint,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const destinationInfo = await connection.getAccountInfo(destinationTokenAccount, 'confirmed');
    if (!destinationInfo) {
      const ataIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        destinationTokenAccount,
        payer.publicKey,
        originMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await sendInstructions(connection, payer, [ataIx]);
    }

    const initialVaultBalance = await getTokenBalance(connection, vaultTokenAccount);

    const treeAccountBefore = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
    expect(treeAccountBefore).not.toBeNull();
    const treeStateBefore = decodeCommitmentTree(new Uint8Array(treeAccountBefore!.data));

    const amount = 1_000n;
    const depositId = 1n;
    const blinding = 2n;

    const commitmentBytes = await poseidonHashMany([
      amount,
      bytesToBigIntLE(payer.publicKey.toBuffer()),
      depositId,
      bytesToBigIntLE(poolStateKey.toBuffer()),
      blinding
    ]);
    const amountCommitBytes = await poseidonHashMany([amount, blinding]);
    const nextTree = await computeNextCommitmentTreeState(treeStateBefore, commitmentBytes, amountCommitBytes);

    const shieldArgs = {
      newRoot: Array.from(toBytes32(nextTree.newRoot)),
      commitment: Array.from(toBytes32(commitmentBytes)),
      amountCommit: Array.from(toBytes32(amountCommitBytes)),
      amount: new BN(amount.toString()),
      proof: Buffer.alloc(0),
      publicInputs: Buffer.alloc(0)
    };

    const shieldKeys = [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: vaultStateKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: originMint, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];

    const shieldIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: shieldKeys,
      data: poolCoder.instruction.encode('shield', { args: shieldArgs })
    });

    await sendInstructions(connection, payer, [shieldIx]);

    const balanceAfterShield = await getTokenBalance(connection, vaultTokenAccount);
    expect(balanceAfterShield).toBe(initialVaultBalance + amount);

    const treeAccountAfterShield = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
    expect(treeAccountAfterShield).not.toBeNull();
    const treeStateAfterShield = decodeCommitmentTree(new Uint8Array(treeAccountAfterShield!.data));
    const oldRootBytes = toBytes32(treeStateAfterShield.currentRoot);

    const noteId = 123n;
    const spendingKey = 456n;
    const nullifierBytes = await poseidonHashMany([noteId, spendingKey]);
    const changeCommitmentBytes = new Uint8Array(32);
    const changeAmountCommitmentBytes = new Uint8Array(32);

    const nextAfterUnshield = await computeNextCommitmentTreeState(
      treeStateAfterShield,
      changeCommitmentBytes,
      changeAmountCommitmentBytes
    );

    const feeAmount = (BigInt(feeBps) * amount) / 10_000n;
    const destinationBytes = new Uint8Array(payer.publicKey.toBytes());
    const modeBytes = new Uint8Array(32);
    modeBytes[0] = 0;

    const publicInputs = Buffer.concat([
      Buffer.from(oldRootBytes),
      Buffer.from(toBytes32(nextAfterUnshield.newRoot)),
      Buffer.from(toBytes32(nullifierBytes)),
      Buffer.from(changeCommitmentBytes),
      Buffer.from(changeAmountCommitmentBytes),
      Buffer.from(u64ToBytes32LE(amount)),
      Buffer.from(u64ToBytes32LE(feeAmount)),
      Buffer.from(destinationBytes),
      Buffer.from(modeBytes),
      Buffer.from(originMint.toBytes()),
      Buffer.from(poolStateKey.toBytes())
    ]);

    const unshieldArgs = {
      oldRoot: Array.from(oldRootBytes),
      newRoot: Array.from(toBytes32(nextAfterUnshield.newRoot)),
      nullifiers: [Array.from(toBytes32(nullifierBytes))],
      outputCommitments: [Array.from(changeCommitmentBytes)],
      outputAmountCommitments: [Array.from(changeAmountCommitmentBytes)],
      amount: new BN(amount.toString()),
      proof: Buffer.alloc(0),
      publicInputs
    };

    const unshieldKeys = [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: factoryStateKey, isSigner: false, isWritable: false },
      { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];

    const unshieldIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: unshieldKeys,
      data: poolCoder.instruction.encode('unshieldToOrigin', { args: unshieldArgs })
    });

    await sendInstructions(connection, payer, [unshieldIx]);

    const finalVaultBalance = await getTokenBalance(connection, vaultTokenAccount);
    expect(finalVaultBalance).toBe(initialVaultBalance);

    const noteLedgerAccount = await connection.getAccountInfo(noteLedgerKey, 'confirmed');
    expect(noteLedgerAccount).not.toBeNull();
    const ledgerBuffer = Buffer.from(noteLedgerAccount!.data);
    let offset = 8; // account discriminator
    offset += 32; // pool pubkey
    const totalMinted = readU128LE(ledgerBuffer, offset);
    offset += 16;
    const totalSpent = readU128LE(ledgerBuffer, offset);
    offset += 16;
    const liveValue = readU128LE(ledgerBuffer, offset);
    offset += 16;
    const notesCreated = readU64LE(ledgerBuffer, offset);
    offset += 8;
    const notesConsumed = readU64LE(ledgerBuffer, offset);

    expect(totalMinted).toBe(amount);
    expect(totalSpent).toBe(amount + feeAmount);
    expect(liveValue).toBe(0n);
    expect(notesCreated).toBe(1n);
    expect(notesConsumed).toBe(1n);

    const nullifierSetAccount = await connection.getAccountInfo(nullifierSetKey, 'confirmed');
    expect(nullifierSetAccount).not.toBeNull();
    const nullifierBuffer = Buffer.from(nullifierSetAccount!.data);
    const nullifierCount = nullifierBuffer.readUInt32LE(8 + 32);
    expect(nullifierCount).toBeGreaterThanOrEqual(1);
  });
});
