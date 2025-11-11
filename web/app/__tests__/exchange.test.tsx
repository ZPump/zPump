import type { ReactNode } from 'react';
import { screen } from '@testing-library/react';
import ConvertPage from '../app/convert/page';
import { renderWithProviders } from '../test-utils/renderWithProviders';

jest.mock('../components/ptf/ConvertForm', () => ({
  ConvertForm: () => <div data-testid="convert-form" />
}));

jest.mock('../components/PageContainer', () => ({
  PageContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="page-container">{children}</div>
  )
}));

describe('ConvertPage', () => {
  it('renders the convert form inside the page container', () => {
    renderWithProviders(<ConvertPage />);

    expect(screen.getByTestId('page-container')).toBeInTheDocument();
    expect(screen.getByTestId('convert-form')).toBeInTheDocument();
  });
});
