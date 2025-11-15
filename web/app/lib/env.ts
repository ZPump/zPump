export type WalletActivityMode = 'local' | 'private';

function resolveWalletActivityMode(): WalletActivityMode {
  const raw =
    process.env.NEXT_PUBLIC_WALLET_ACTIVITY_MODE ??
    process.env.WALLET_ACTIVITY_MODE ??
    'local';
  return raw === 'private' ? 'private' : 'local';
}

export const WALLET_ACTIVITY_MODE: WalletActivityMode = resolveWalletActivityMode();

