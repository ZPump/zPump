import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('YNZGqPEsKkMcUopmXThpigDdxfCYPE6jS1QtsXfRzjV');
export const POOL_PROGRAM_ID = new PublicKey('GBfBiuyXm5YZjnCPkZNjakht41rxEkMRxawQcocowwdi');
export const VAULT_PROGRAM_ID = new PublicKey('ABUQvsF8kdY9HCFrVEomafg9ABbq4zVQuxLfevpwGnvb');
export const VERIFIER_PROGRAM_ID = new PublicKey('3aCv39mCRFH9BGJskfXqwQoWzW1ULq2yXEbEwGgKtLgg');

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
  })()
} as const;

export const VERIFIER_VERSION = 1;

