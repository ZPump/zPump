declare module 'circomlibjs' {
  export type Poseidon = (inputs: (string | number | bigint)[]) => Uint8Array;
  export function buildPoseidon(): Promise<Poseidon>;
  const circomlib: {
    poseidon: (...args: unknown[]) => bigint;
    buildPoseidon: typeof buildPoseidon;
  };
  export default circomlib;
}
