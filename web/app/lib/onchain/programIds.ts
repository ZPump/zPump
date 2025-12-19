import { PublicKey } from '@solana/web3.js';
import { AddressLookupTableProgram } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('AG2eT5fyfPdv6wjDWCxr5Y9JBK9cD5rahLzuz2UbbBvg');
export const POOL_PROGRAM_ID = new PublicKey('9ykdCimDZGsCBB9ihC9QfDKib4KxYzpRZZTVrGp425Ku');
export const VAULT_PROGRAM_ID = new PublicKey('iHWU2DfontkA7ZT2C6hFph3SSpkTjPm2a4t2C54CxSw');
export const VERIFIER_PROGRAM_ID = new PublicKey('DMvUxHwdJGkaRAJFXEKgDxsmVXL3gYttNsVP16xEr9TE');
export const DEX_PROGRAM_ID = new PublicKey('HRbTSfU2WoUWqq2Y7y5WfGPy7LaXxMQoyrcdJPfEhd7U');

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

