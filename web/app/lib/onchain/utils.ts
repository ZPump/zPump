export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}

export function bigIntToBytesLE(value: bigint, length = 32): Uint8Array {
  const result = new Uint8Array(length);
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    result[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function canonicalizeHex(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `0x${'0'.repeat(64)}`;
  }
  let body: string;
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    body = trimmed.slice(2);
  } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    body = trimmed;
  } else if (/^\d+$/.test(trimmed)) {
    body = BigInt(trimmed).toString(16);
  } else {
    throw new Error(`Invalid hex string: ${value}`);
  }
  const normalised = body.replace(/^0+/, '') || '0';
  return `0x${normalised.padStart(64, '0').toLowerCase()}`;
}

export function canonicalHexToBytesLE(hex: string, expectedLength = 32): Uint8Array {
  const canonical = canonicalizeHex(hex);
  const body = canonical.slice(2);
  if (body.length % 2 !== 0) {
    throw new Error(`Canonical hex must contain an even number of characters: ${canonical}`);
  }
  const byteLength = body.length / 2;
  const be = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    const byte = body.slice(i * 2, i * 2 + 2);
    be[i] = Number.parseInt(byte, 16);
  }
  const le = new Uint8Array(expectedLength);
  const copyLength = Math.min(expectedLength, be.length);
  for (let i = 0; i < copyLength; i += 1) {
    le[i] = be[be.length - 1 - i];
  }
  return le;
}

export function bytesLEToCanonicalHex(bytes: Uint8Array): string {
  const be = Array.from(bytes)
    .reverse()
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `0x${be}`;
}

export function hexToBytes(hex: string, expectedLength?: number): Uint8Array {
  const bytes = canonicalHexToBytesLE(hex, expectedLength ?? 32);
  if (expectedLength && bytes.length !== expectedLength) {
    return bytes.slice(0, expectedLength);
  }
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

