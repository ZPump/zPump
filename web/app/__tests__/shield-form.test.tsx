import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShieldForm } from '../components/ptf/ShieldForm';

const useWalletMock = jest.fn();
const requestProofMock = jest.fn();
const shieldMock = jest.fn();

jest.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => useWalletMock(),
  useConnection: () => ({ connection: {} })
}));

jest.mock('../lib/proofClient', () => ({
  ProofClient: jest.fn().mockImplementation(() => ({
    requestProof: requestProofMock
  }))
}));

jest.mock('../lib/sdk', () => ({
  shield: shieldMock
}));

describe('ShieldForm', () => {
  beforeEach(() => {
    useWalletMock.mockReset();
    requestProofMock.mockReset();
    shieldMock.mockReset();
  });

  it('requires a connected wallet', async () => {
    useWalletMock.mockReturnValue({ publicKey: null });

    render(<ShieldForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate proof & submit/i }));

    await waitFor(() => expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument());
    expect(requestProofMock).not.toHaveBeenCalled();
    expect(shieldMock).not.toHaveBeenCalled();
  });

  it('requests a proof and submits the transaction', async () => {
    const publicKey = { toBase58: () => 'Wallet111111111111111111111111111111111111' };
    useWalletMock.mockReturnValue({ publicKey });

    requestProofMock.mockResolvedValue({
      proof: '0xproof',
      publicInputs: ['root', 'commitment', '0xfeed'],
      verifyingKeyHash: '0xvk'
    });
    shieldMock.mockResolvedValue('signature111');

    render(<ShieldForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate proof & submit/i }));

    await waitFor(() => expect(shieldMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith('shield', expect.objectContaining({ mintId: expect.any(String) }));
    expect(screen.getByText(/Shield transaction sent/i)).toBeInTheDocument();
  });
});
