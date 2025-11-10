import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExchangePage from '../app/exchange/page';

const disconnectMock = jest.fn();
const setVisibleMock = jest.fn();

jest.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: true, disconnect: disconnectMock, publicKey: { toBase58: () => 'ABCDEF123456' } })
}));

jest.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible: setVisibleMock })
}));

describe('ExchangePage', () => {
  it('allows selecting shielding mode and submitting', async () => {
    render(<ExchangePage />);

    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Mode/i), { target: { value: 'unshield-origin' } });

    fireEvent.click(screen.getByRole('button', { name: /Simulate Exchange/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Simulating/i })).toBeDisabled());
  });
});
