import { PublicKey } from '@solana/web3.js';

export const FACTORY_PROGRAM_ID = new PublicKey('4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy');
export const POOL_PROGRAM_ID = new PublicKey('4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre');
export const VAULT_PROGRAM_ID = new PublicKey('9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh');
export const VERIFIER_PROGRAM_ID = new PublicKey('Gm2KXvGhWrEeYERh3sxs1gwffMXeajVQXqY7CcBpm7Ua');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const textEncoder = new TextEncoder();

export const CIRCUIT_TAGS = {
  shield: (() => {
    const bytes = new Uint8Array(32);
    bytes.set(textEncoder.encode('shield'));
    return bytes;
  })()
} as const;

export const VERIFIER_VERSION = 1;

