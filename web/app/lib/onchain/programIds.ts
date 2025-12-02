import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('6uruFJACS8n2H28vWA39XqnPwRinL3P1DPLipySZfAuM');
export const POOL_PROGRAM_ID = new PublicKey('F8bEMyP6Yt3SMGVT9jKL6m13Sn6mc1Z5AeuuJPNCR8to');
export const VAULT_PROGRAM_ID = new PublicKey('Cp154M1oxXYJDbrgg9f57ytuthW8X8WNe73NQ7kQQr4Q');
export const VERIFIER_PROGRAM_ID = new PublicKey('geepCeZMrQu1Fh8mXYTxUcZhkw858R2joYXwqRQVS9S');
export const DEX_PROGRAM_ID = new PublicKey('5Dvt8enX3PgC5hJmzcpB7iuZX6LcYYLP12WXVv7Uef2G');

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

