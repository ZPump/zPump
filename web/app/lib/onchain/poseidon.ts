import type { Poseidon } from 'circomlibjs';

let poseidonInstance: Poseidon | null = null;

async function loadPoseidon(): Promise<Poseidon> {
  if (!poseidonInstance) {
    const circomlib = await import('circomlibjs');
    poseidonInstance = await circomlib.buildPoseidon();
  }
  return poseidonInstance;
}

export async function poseidonHash2(left: bigint, right: bigint): Promise<Uint8Array> {
  const poseidon = await loadPoseidon();
  return poseidon([left, right]);
}

export async function poseidonHashMany(values: bigint[]): Promise<Uint8Array> {
  const poseidon = await loadPoseidon();
  return poseidon(values);
}

