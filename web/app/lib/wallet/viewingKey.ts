import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export interface ViewingKeyInfo {
  viewKey: string;
  viewId: string;
}

export function deriveViewingKey(secretKeyBase58: string): ViewingKeyInfo | null {
  try {
    const secretBytes = bs58.decode(secretKeyBase58);
    const viewKeyBytes = sha256(secretBytes);
    const viewKeyHex = bytesToHex(viewKeyBytes);
    const viewIdBytes = sha256(viewKeyBytes);
    const viewIdHex = bytesToHex(viewIdBytes);
    return {
      viewKey: viewKeyHex,
      viewId: viewIdHex
    };
  } catch {
    return null;
  }
}

