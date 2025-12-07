import { PublicKey } from '@solana/web3.js';
import { POOL_PROGRAM_ID, VAULT_PROGRAM_ID, FACTORY_PROGRAM_ID, VERIFIER_PROGRAM_ID, DEX_PROGRAM_ID, CIRCUIT_TAGS, VERIFIER_VERSION } from './programIds';

const textEncoder = new TextEncoder();

export function derivePoolState(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('pool'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveNullifierSet(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('nulls'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveNoteLedger(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('notes'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveCommitmentTree(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('tree'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveHookConfig(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('hooks'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveHookWhitelist(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('hook-whitelist'), originMint.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveShieldClaim(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('claim'), pool.toBuffer()], POOL_PROGRAM_ID)[0];
}

export function deriveAllowanceAccount(pool: PublicKey, owner: PublicKey, spender: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('allow'), pool.toBuffer(), owner.toBuffer(), spender.toBuffer()],
    POOL_PROGRAM_ID
  )[0];
}

export function deriveVaultState(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('vault'), originMint.toBuffer()], VAULT_PROGRAM_ID)[0];
}

export function deriveMintMapping(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('map'), originMint.toBuffer()], FACTORY_PROGRAM_ID)[0];
}

export function deriveTokenMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('metadata'), mint.toBuffer()], FACTORY_PROGRAM_ID)[0];
}

export function deriveFactoryState(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('factory'), FACTORY_PROGRAM_ID.toBuffer()],
    FACTORY_PROGRAM_ID
  )[0];
}

export function deriveFactoryConfig(): PublicKey {
  const factoryState = deriveFactoryState();
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('factory-config'), factoryState.toBuffer()],
    FACTORY_PROGRAM_ID
  )[0];
}

export function deriveVerifyingKey(circuitTag: Uint8Array = CIRCUIT_TAGS.shield): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('vk'), circuitTag, new Uint8Array([VERIFIER_VERSION])],
    VERIFIER_PROGRAM_ID
  )[0];
}

/**
 * Derives the DEX pool state PDA for a token pair.
 * Seeds: ["pool", token_a_mint, token_b_mint]
 * Tokens must be in canonical order (token_a < token_b).
 */
export function deriveDexPoolState(tokenA: PublicKey, tokenB: PublicKey): PublicKey {
  // Ensure canonical order (token_a < token_b)
  const [tokenAMint, tokenBMint] = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0 
    ? [tokenA, tokenB] 
    : [tokenB, tokenA];
  
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('pool'), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
    DEX_PROGRAM_ID
  )[0];
}

/**
 * Derives the lookup table registry PDA for a pool.
 * This registry stores the lookup table address for a pool, enabling O(1) lookup.
 * 
 * One registry per pool, shared by all users. First user creates the lookup table
 * and initializes the registry. Subsequent users read the registry to get the
 * lookup table address.
 * 
 * This approach is:
 * - Scalable: O(1) lookup regardless of number of tokens
 * - Decentralized: On-chain storage, no central authority
 * - Efficient: One lookup table per pool, shared by all users
 */
