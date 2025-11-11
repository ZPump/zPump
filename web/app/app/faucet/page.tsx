import { Metadata } from 'next';
import { PageContainer } from '../../components/PageContainer';
import { FaucetDashboard } from '../../components/wallet/FaucetDashboard';

export const metadata: Metadata = {
  title: 'Faucet | zPump',
  description: 'Fund simulation wallets with test SOL and mint origin or zTokens for sandboxing flows.'
};

export default function FaucetPage() {
  return (
    <PageContainer maxW="5xl">
      <FaucetDashboard />
    </PageContainer>
  );
}

