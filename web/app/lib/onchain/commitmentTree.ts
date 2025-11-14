import { PublicKey } from '@solana/web3.js';
import { bytesToBigIntLE, bigIntToBytesLE, bytesLEToCanonicalHex } from './utils';
import { poseidonHash2 } from './poseidon';

const DISCRIMINATOR_SIZE = 8;
const PUBKEY_SIZE = 32;
const U64_SIZE = 8;
const DEPTH = 32;
const MAX_CANOPY = 16;

export interface CommitmentTreeState {
  pool: PublicKey;
  canopyDepth: number;
  nextIndex: bigint;
  currentRoot: Uint8Array;
  frontier: Uint8Array[];
  zeroes: Uint8Array[];
}

export function decodeCommitmentTree(accountData: Uint8Array): CommitmentTreeState {
  if (accountData.length === 0) {
    throw new Error('Commitment tree account empty');
  }
  let offset = DISCRIMINATOR_SIZE;
  const poolBytes = accountData.slice(offset, offset + PUBKEY_SIZE);
  const pool = new PublicKey(poolBytes);
  offset += PUBKEY_SIZE;

  const canopyDepth = accountData[offset];
  offset += 1;
  // Struct is #[repr(C)] with u8 followed by u64, so skip alignment padding.
  offset += 7;

  const nextIndex = bytesToBigIntLE(accountData.slice(offset, offset + U64_SIZE));
  offset += U64_SIZE;

  const currentRoot = accountData.slice(offset, offset + PUBKEY_SIZE);
  offset += PUBKEY_SIZE;

  const frontier: Uint8Array[] = [];
  for (let i = 0; i < DEPTH; i += 1) {
    frontier.push(accountData.slice(offset, offset + PUBKEY_SIZE));
    offset += PUBKEY_SIZE;
  }

  const zeroes: Uint8Array[] = [];
  for (let i = 0; i < DEPTH; i += 1) {
    zeroes.push(accountData.slice(offset, offset + PUBKEY_SIZE));
    offset += PUBKEY_SIZE;
  }

  offset += MAX_CANOPY * PUBKEY_SIZE; // canopy
  offset += MAX_CANOPY * PUBKEY_SIZE; // recent commitments
  offset += MAX_CANOPY * PUBKEY_SIZE; // recent amount commitments
  offset += MAX_CANOPY * U64_SIZE; // recent indices
  offset += 1; // recent_len
  offset += 1; // bump
  // trailing padding ignored

  return {
    pool,
    canopyDepth,
    nextIndex,
    currentRoot,
    frontier,
    zeroes
  };
}

export async function computeNextCommitmentTreeState(
  state: CommitmentTreeState,
  commitment: Uint8Array,
  amountCommitment: Uint8Array
): Promise<{ newRoot: Uint8Array; nextIndex: bigint; frontier: Uint8Array[] }> {
  const frontier = state.frontier.map((entry) => entry.slice());
  let node = commitment;
  let index = Number(state.nextIndex);

  for (let level = 0; level < DEPTH; level += 1) {
    if (index % 2 === 0) {
      frontier[level] = node;
      const left = bytesToBigIntLE(node);
      const right = bytesToBigIntLE(state.zeroes[level]);
      node = await poseidonHash2(left, right);
    } else {
      const left = bytesToBigIntLE(frontier[level]);
      const right = bytesToBigIntLE(node);
      node = await poseidonHash2(left, right);
    }
    index >>= 1;
  }

  const newRoot = node;
  const nextIndex = state.nextIndex + 1n;
  const amountCommitmentClone = amountCommitment.slice(); // currently unused but kept for future extensions
  void amountCommitmentClone;

  return {
    newRoot,
    nextIndex,
    frontier
  };
}

export function commitmentToHex(commitment: Uint8Array): string {
  return bytesLEToCanonicalHex(commitment);
}

export function bigintToBytes32LE(value: bigint): Uint8Array {
  return bigIntToBytesLE(value, 32);
}

