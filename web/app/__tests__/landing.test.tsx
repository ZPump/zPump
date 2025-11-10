import { render, screen } from '@testing-library/react';
import HomePage from '../app/page';

jest.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: false, disconnect: jest.fn(), publicKey: { toBase58: () => '1111' } })
}));

jest.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible: jest.fn() })
}));

describe('HomePage', () => {
  it('renders key landing content', () => {
    render(<HomePage />);

    expect(screen.getByText(/Privacy rails for every SPL asset/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enter the Pool/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Exchange/i })).toBeInTheDocument();
  });
});
