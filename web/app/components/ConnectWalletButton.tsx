'use client';

import { Button } from '@chakra-ui/react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMinimal } from 'lucide-react';

export function ConnectWalletButton() {
  const { setVisible } = useWalletModal();
  const { connected, disconnect, publicKey } = useWallet();

  const handleClick = () => {
    if (connected) {
      disconnect();
    } else {
      setVisible(true);
    }
  };

  return (
    <Button variant={connected ? 'outline' : 'glow'} onClick={handleClick} leftIcon={<WalletMinimal size={18} />}>
      {connected ? `${publicKey?.toBase58().slice(0, 4)}…${publicKey?.toBase58().slice(-4)}` : 'Connect Wallet'}
    </Button>
  );
}
