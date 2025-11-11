import { Metadata } from 'next';
import { PageContainer } from '../../components/PageContainer';
import { VaultDashboard } from '../../components/vault/VaultDashboard';

export const metadata: Metadata = {
  title: 'Vault Dashboard | zPump',
  description: 'Inspect vault balances and mint metadata for each origin asset after bootstrapping the private devnet.'
};

export default function VaultPage() {
  return (
    <PageContainer maxW="6xl">
      <VaultDashboard />
    </PageContainer>
  );
}
