import {
  canonicalizeHex,
  canonicalHexToBytesLE,
  bytesLEToCanonicalHex,
  hexToBytes
} from '../lib/onchain/utils';

const SAMPLE_VALUES = [
  '0x0',
  '0x1',
  '0xabcdef',
  'abcdef',
  '123456789',
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
];

describe('canonical hex conversions', () => {
  it('produces 32-byte little-endian arrays that round-trip to canonical hex', () => {
    for (const value of SAMPLE_VALUES) {
      const canonical = canonicalizeHex(value);
      expect(canonical).toMatch(/^0x[0-9a-f]{64}$/);
      const bytes = canonicalHexToBytesLE(canonical, 32);
      expect(bytes).toHaveLength(32);
      const roundTrip = bytesLEToCanonicalHex(bytes);
      expect(roundTrip).toBe(canonical);
    }
  });

  it('keeps the least significant byte at index 0 when parsing hex strings', () => {
    const canonical = canonicalizeHex('0x01');
    const bytes = hexToBytes(canonical, 32);
    expect(bytes[0]).toBe(0x01);
    expect(bytes.slice(1)).toEqual(new Uint8Array(31));
  });
});
