import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('GoeeSg56B2WVNjLWANJ6LkqVwk45ynJ8wRQXY7pohrUX');
export const POOL_PROGRAM_ID = new PublicKey('guKkNcvnhiKPPK9e2qwYWWPZWdLfk78QwFcVEL4hAbu');
export const VAULT_PROGRAM_ID = new PublicKey('2FqT4DWhPhRc2ubFoDXmh64dPEwXdonEPRMFQzyC5hkk');
export const VERIFIER_PROGRAM_ID = new PublicKey('29Ma1tESp3ehhBFU4dNNPQW2YDAFQNfPAudvaou4kfZC');
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

