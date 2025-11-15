import { WALLET_ACTIVITY_MODE } from '../env';

export type WalletActivityType = 'wrap' | 'unwrap' | 'transfer' | 'transfer_from';

export interface WalletActivityEntry {
  id: string;
  type: WalletActivityType;
  signature: string;
  symbol: string;
  amount: string;
  timestamp: number;
}

export interface WalletActivityPayload extends WalletActivityEntry {
  wallet?: string;
}

interface WalletActivityOptions {
  viewId?: string;
}

const EVENT_NAME = 'zpump:activity';

function dispatchActivityEvent() {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    // ignore event dispatch failures
  }
}

export async function fetchWalletActivity(
  wallet: string | null | undefined,
  options?: WalletActivityOptions
): Promise<WalletActivityEntry[]> {
  if (WALLET_ACTIVITY_MODE === 'local') {
    if (!wallet) {
      return [];
    }
    const response = await fetch(`/api/activity/${wallet}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('failed_to_fetch_activity');
    }
    const payload = (await response.json()) as { entries?: WalletActivityEntry[] };
    return payload.entries ?? [];
  }

  if (WALLET_ACTIVITY_MODE === 'private') {
    const viewId = options?.viewId;
    if (!viewId) {
      return [];
    }
    const response = await fetch(`/api/indexer/activity/${viewId}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('failed_to_fetch_activity');
    }
    const payload = (await response.json()) as { entries?: WalletActivityEntry[] };
    return payload.entries ?? [];
  }

  return [];
}

export async function recordWalletActivity(
  entry: WalletActivityPayload,
  options?: WalletActivityOptions
): Promise<void> {
  if (WALLET_ACTIVITY_MODE === 'local') {
    if (!entry.wallet) {
      return;
    }
    try {
      await fetch(`/api/activity/${entry.wallet}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      dispatchActivityEvent();
    } catch {
      // ignore logging failures, UI already succeeded
    }
    return;
  }

  if (WALLET_ACTIVITY_MODE === 'private') {
    const viewId = options?.viewId;
    if (!viewId) {
      return;
    }
    try {
      await fetch(`/api/indexer/activity/${viewId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      dispatchActivityEvent();
    } catch {
      // ignore logging failures
    }
  }
}

export function subscribeToWalletActivity(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const handler = () => callback();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

