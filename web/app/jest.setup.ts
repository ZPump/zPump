import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';
import nodeCrypto from 'crypto';

global.navigator.clipboard = {
  writeText: jest.fn()
} as unknown as Clipboard;

const globalWithPolyfill = globalThis as typeof globalThis & {
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
  crypto: Crypto & { randomUUID?: () => string };
};

if (typeof globalWithPolyfill.TextEncoder === 'undefined') {
  globalWithPolyfill.TextEncoder = TextEncoder as typeof globalWithPolyfill.TextEncoder;
}

if (typeof globalWithPolyfill.TextDecoder === 'undefined') {
  globalWithPolyfill.TextDecoder = TextDecoder as typeof globalWithPolyfill.TextDecoder;
}

if (!globalWithPolyfill.crypto || typeof globalWithPolyfill.crypto.getRandomValues === 'undefined') {
  globalWithPolyfill.crypto = {
    ...globalWithPolyfill.crypto,
    getRandomValues: (array: Uint8Array) => {
      const buffer = nodeCrypto.randomBytes(array.length);
      array.set(buffer);
      return array;
    },
    randomUUID: () => nodeCrypto.randomUUID()
  } as Crypto;
}
