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

export function hexToBytes(hex: string, expectedLength?: number): Uint8Array {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  const length = Math.ceil(normalised.length / 2);
  const buffer = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    const byte = normalised.slice(normalised.length - (i + 1) * 2, normalised.length - i * 2) || '00';
    buffer[i] = Number.parseInt(byte, 16);
  }
  if (expectedLength && buffer.length !== expectedLength) {
    const padded = new Uint8Array(expectedLength);
    padded.set(buffer.slice(0, expectedLength));
    return padded;
  }
  return buffer;
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

