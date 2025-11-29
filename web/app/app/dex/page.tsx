import { Metadata } from 'next';
import { PageContainer } from '../../components/PageContainer';
import { DexPage } from '../../components/dex/DexPage';

export const metadata: Metadata = {
  title: 'DEX | zPump',
  description: 'Universal, permissionless DEX supporting any token pair. Trade tokens privately with zTokens.'
};

export default function Dex() {
  return (
    <PageContainer maxW="6xl">
      <DexPage />
    </PageContainer>
  );
}
