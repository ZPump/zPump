import { Metadata } from 'next';
import { MintZTokenForm } from '../../components/ptf/MintZTokenForm';
import { PageContainer } from '../../components/PageContainer';

export const metadata: Metadata = {
  title: 'Mint zToken | zPump',
  description: 'Mint a new native zToken with metadata stored on IPFS.'
};

export default function MintZTokenPage() {
  return (
    <PageContainer>
      <MintZTokenForm />
    </PageContainer>
  );
}

