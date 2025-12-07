import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('2vYEqzgPNSxGxnQCEGqJb8vqZKSs2h183NtzCzW1i4LW');
export const POOL_PROGRAM_ID = new PublicKey('Av2D8ADegRt1zTfqEABidkcMH2zzusrDLwAeDFgfdQ1k');
export const VAULT_PROGRAM_ID = new PublicKey('7Wr9XMjYfPm6HTN3ZV7r4wHnoV2zospvNN5A1xgoER8m');
export const VERIFIER_PROGRAM_ID = new PublicKey('2V5XN9rpubXdK3cdWBBjZwjxMpMzQBKTaN3moEJ59a8K');
export const DEX_PROGRAM_ID = new PublicKey('4HKwSSZXkVMo5JKk92sMNhhUfcHCWzXYG8eVj6aPymar');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Address Lookup Table Program ID
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = AddressLookupTableProgram.programId;

const textEncoder = new TextEncoder();

export const CIRCUIT_TAGS = {
  shield: (() => {
    const bytes = new Uint8Array(32);
    bytes.set(textEncoder.encode('shield'));
    return bytes;
  })(),
  unshield: (() => {
    const bytes = new Uint8Array(32);
    bytes.set(textEncoder.encode('unshield'));
    return bytes;
  })(),
  transfer: (() => {
    const bytes = new Uint8Array(32);
    bytes.set(textEncoder.encode('transfer'));
    return bytes;
  })()
} as const;

export const VERIFIER_VERSION = 1;

