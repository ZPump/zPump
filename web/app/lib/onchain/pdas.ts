import { PublicKey } from '@solana/web3.js';
import { POOL_PROGRAM_ID, VAULT_PROGRAM_ID, FACTORY_PROGRAM_ID, VERIFIER_PROGRAM_ID, CIRCUIT_TAGS, VERIFIER_VERSION } from './programIds';

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

export function deriveVaultState(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('vault'), originMint.toBuffer()], VAULT_PROGRAM_ID)[0];
}

export function deriveMintMapping(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([textEncoder.encode('map'), originMint.toBuffer()], FACTORY_PROGRAM_ID)[0];
}

export function deriveFactoryState(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('factory'), FACTORY_PROGRAM_ID.toBuffer()],
    FACTORY_PROGRAM_ID
  )[0];
}

export function deriveVerifyingKey(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('vk'), CIRCUIT_TAGS.shield, new Uint8Array([VERIFIER_VERSION])],
    VERIFIER_PROGRAM_ID
  )[0];
}

