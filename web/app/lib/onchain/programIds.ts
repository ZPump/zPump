import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('HaPDYkR2CWsxfAwg6rT5G1ZZ9vPH14CNXZo9s6AyYKNK');
export const POOL_PROGRAM_ID = new PublicKey('BTjQKK2eqCuygoJZYPyydTfB2wvuWnJkmyg2y25HCrmU');
export const VAULT_PROGRAM_ID = new PublicKey('Muko1fue2j1At1U6v2xJ7cuwas5uSUjZHVGppbpT8yq');
export const VERIFIER_PROGRAM_ID = new PublicKey('AhSvt3Be9akJHhnWRD9XJcBrjs5uawosBdQdwgoANHcT');
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

