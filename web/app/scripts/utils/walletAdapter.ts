import {
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  Transaction
} from '@solana/web3.js';

export type WalletAdapterLike = {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
  sendTransaction: (tx: Transaction, connection: Connection, options?: SendOptions) => Promise<string>;
};

export function createWalletAdapter(payer: Keypair): WalletAdapterLike {
  return {
    publicKey: payer.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(payer);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      return txs.map((tx) => {
        tx.partialSign(payer);
        return tx;
      });
    },
    sendTransaction: async (tx: Transaction, connection: Connection, options?: SendOptions) => {
      tx.partialSign(payer);
      return connection.sendRawTransaction(tx.serialize(), options);
    }
  };
}

