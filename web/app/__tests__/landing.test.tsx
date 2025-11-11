import { fireEvent, screen } from '@testing-library/react';
import HomePage from '../app/page';
import { renderWithProviders } from '../test-utils/renderWithProviders';

jest.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: false, disconnect: jest.fn(), publicKey: { toBase58: () => '1111' } })
}));

jest.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible: jest.fn() })
}));

describe('HomePage', () => {
  it('renders key landing content', () => {
    renderWithProviders(<HomePage />);

    expect(screen.getByText(/Convert any SPL asset into zTokens/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Launch the Converter/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/i }));
    expect(screen.getByRole('link', { name: /Vaults/i })).toBeInTheDocument();
  });
});
