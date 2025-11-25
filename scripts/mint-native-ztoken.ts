import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { mintNativeZToken } from '../web/app/lib/sdk';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import fs from 'fs';

function loadKeypair(): Keypair {
  const keyPath = `${process.env.HOME}/.config/solana/id.json`;
  const secret = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as number[];
  return Keypair.fromSecretKey(Buffer.from(secret));
}

async function main() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const keypair = loadKeypair();

  const wallet: WalletContextState = {
    publicKey: keypair.publicKey,
    sendTransaction: async (tx: Transaction, conn: Connection, options) => {
      tx.partialSign(keypair);
      return conn.sendRawTransaction(tx.serialize(), options);
    },
    signTransaction: undefined,
    signAllTransactions: undefined,
    connected: true,
    connecting: false,
    disconnecting: false,
    autoApprove: false,
    select: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    wallet: null,
  } as any;

  try {
    const result = await mintNativeZToken({
      connection,
      wallet,
      name: 'Test Token',
      symbol: 'TEST',
      uri: 'ipfs://bafkreigh2akiscaildc6',
      decimals: 6,
      initialSupply: BigInt(1_000_000),
    });
    console.log('Mint success', result.signature, 'origin mint', result.originMint);
  } catch (error) {
    console.error('Mint failed', error);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
