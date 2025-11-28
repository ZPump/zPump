import { Metadata } from 'next';
import { ConvertForm } from '../../components/ptf/ConvertForm';
import { PageContainer } from '../../components/PageContainer';

export const metadata: Metadata = {
  title: 'Shield | zPump',
  description: 'Shield tokens into privacy or unshield them back to public SPL accounts from a single flow.'
};

export default function ConvertPage() {
  return (
    <PageContainer>
      <ConvertForm />
    </PageContainer>
  );
}

