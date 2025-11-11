import { Metadata } from 'next';
import { ConvertForm } from '../../components/ptf/ConvertForm';
import { PageContainer } from '../../components/PageContainer';

export const metadata: Metadata = {
  title: 'Convert | zPump',
  description: 'Shield into zTokens or redeem back to public SPL tokens from a single, simplified flow.'
};

export default function ConvertPage() {
  return (
    <PageContainer>
      <ConvertForm />
    </PageContainer>
  );
}

