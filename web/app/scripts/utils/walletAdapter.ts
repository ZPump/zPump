import {
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  Transaction,
  VersionedTransaction
} from '@solana/web3.js';
import { isVersionedTransaction } from '@solana/wallet-adapter-base';

export type WalletAdapterLike = {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
  sendTransaction: (tx: Transaction | VersionedTransaction, connection: Connection, options?: SendOptions) => Promise<string>;
};

export function createWalletAdapter(payer: Keypair): WalletAdapterLike {
  return {
    publicKey: payer.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (isVersionedTransaction(tx)) {
        tx.sign([payer]);
      } else {
        tx.partialSign(payer);
      }
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      return txs.map((tx) => {
        if (isVersionedTransaction(tx)) {
          tx.sign([payer]);
        } else {
          tx.partialSign(payer);
        }
        return tx;
      });
    },
    sendTransaction: async (tx: Transaction | VersionedTransaction, connection: Connection, options?: SendOptions) => {
      if (isVersionedTransaction(tx)) {
        tx.sign([payer]);
        return connection.sendRawTransaction(tx.serialize(), options);
      } else {
        tx.partialSign(payer);
        return connection.sendRawTransaction(tx.serialize(), options);
      }
    }
  };
}

