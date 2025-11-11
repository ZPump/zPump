import { Metadata } from 'next';
import { PageContainer } from '../../components/PageContainer';
import { WalletDashboard } from '../../components/wallet/WalletDashboard';

export const metadata: Metadata = {
  title: 'Wallet | zPump',
  description: 'View public balances, shielded assets, and recent activity from your connected wallet.'
};

export default function WalletPage() {
  return (
    <PageContainer maxW="6xl">
      <WalletDashboard />
    </PageContainer>
  );
}

