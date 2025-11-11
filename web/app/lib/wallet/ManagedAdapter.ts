'use client';

import { ed25519 } from '@noble/curves/ed25519';
import type { WalletName } from '@solana/wallet-adapter-base';
import {
  BaseSignInMessageSignerWalletAdapter,
  isVersionedTransaction,
  WalletNotConnectedError,
  WalletReadyState
} from '@solana/wallet-adapter-base';
import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features';
import { createSignInMessage } from '@solana/wallet-standard-util';
import type { Transaction, TransactionVersion, VersionedTransaction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';

export const ManagedWalletName = 'zPump Local Wallet' as WalletName<'zPump Local Wallet'>;

export class ManagedKeypairWalletAdapter extends BaseSignInMessageSignerWalletAdapter {
  name = ManagedWalletName;
  url = 'https://zpump.dev';
  icon =
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHZpZXdCb3g9IjAgMCAzNCAzNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBvcGFjaXR5PSIwLjkiPjxjaXJjbGUgY3g9IjE3IiBjeT0iMTciIHI9IjE3IiBmaWxsPSIjM0JDRDFGIi8+PHBhdGggZD0iTTIwLjA0IDEwLjQ3M0gxNS4wMTRWOC4yMjZDMTUuMDE0IDcuNTI2NyAxNC40ODggNi45OTk1IDEzLjc5NSA2Ljk5OTVIMTIuMDA2QzExLjMxMyA2Ljk5OTUgMTAuNzg3IDcuNTI2NyAxMC43ODcgOC4yMjY0VjE2Ljg4MUMxMC43ODcgMTcuNTgxIDExLjMxMyAxOC4xMDggMTIuMDA2IDE4LjEwOEgxMy43OTZDMTEuOTM0IDE5Ljg1MSAxMS44MDEgMjEuOTgxIDEzLjQ0NSAyMy43MjNMMTguMzcxIDI4LjcxOEMxOC44OTQgMjkuMjY2IDE5Ljc1MiAyOS4zMDggMjAuMzE5IDI4LjgwNEMyMC45MDggMjguMjc5IDIxLjAwOSAyNy40NzEgMjEuMDA5IDI2LjUyVjEyLjE4OEMyMS4wMDkgMTEuMzIyIDIxLjY5NiAxMC42MjcgMjIuNTIyIDEwLjYyN0gyMy41NUMyNC4zNzYgMTAuNjI3IDI1LjA2MyAxMS4zMjMgMjUuMDYzIDEyLjE4OFYyNC4wOThDMjUuMDYzIDI2LjgzNyAyMy4wODcgMjkgMjAuNzIgMjlIMTcuMDFDMTAuOTQgMjkgNS45NTEyIDIzLjkxNSA1Ljk1MTIgMTcuMTIyVjEyLjEwNUM1Ljk1MTIgNi40Njg5IDEwLjAzOSAyIDIwLjA0IDJaIiBmaWxsPSIjMDUwNTEwIi8+PC9nPjwvc3ZnPg==';
  supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0]);

  private _keypair: Keypair | null = null;
  private _connected = false;

  get connecting() {
    return false;
  }

  get publicKey() {
    return this._keypair?.publicKey ?? null;
  }

  get readyState() {
    return WalletReadyState.Loadable;
  }

  setKeypair(keypair: Keypair) {
    this._keypair = keypair;
    if (this._connected) {
      this.emit('connect', keypair.publicKey);
    }
  }

  async connect(): Promise<void> {
    if (!this._keypair) {
      this._keypair = new Keypair();
    }
    this._connected = true;
    this.emit('connect', this._keypair.publicKey);
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._keypair = null;
    this.emit('disconnect');
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (!this._keypair) throw new WalletNotConnectedError();

    if (isVersionedTransaction(transaction)) {
      transaction.sign([this._keypair]);
    } else {
      transaction.partialSign(this._keypair);
    }

    return transaction;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this._keypair) throw new WalletNotConnectedError();
    return ed25519.sign(message, this._keypair.secretKey.slice(0, 32));
  }

  async signIn(input: SolanaSignInInput = {}): Promise<SolanaSignInOutput> {
    const { publicKey, secretKey } = (this._keypair ||= new Keypair());
    const domain = input.domain || window.location.host;
    const address = input.address || publicKey.toBase58();

    const signedMessage = createSignInMessage({
      ...input,
      domain,
      address
    });
    const signature = ed25519.sign(signedMessage, secretKey.slice(0, 32));

    this.emit('connect', publicKey);

    return {
      account: {
        address,
        publicKey: publicKey.toBytes(),
        chains: [],
        features: []
      },
      signedMessage,
      signature
    };
  }
}

