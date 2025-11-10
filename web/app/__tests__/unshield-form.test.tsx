import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { UnshieldForm } from '../components/ptf/UnshieldForm';

const useWalletMock = jest.fn();
const requestProofMock = jest.fn();
const unshieldMock = jest.fn();
const resolvePublicKeyMock = jest.fn();

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
  unshield: unshieldMock,
  resolvePublicKey: resolvePublicKeyMock
}));

describe('UnshieldForm', () => {
  beforeEach(() => {
    useWalletMock.mockReset();
    requestProofMock.mockReset();
    unshieldMock.mockReset();
    resolvePublicKeyMock.mockReset();
  });

  it('requires a connected wallet', async () => {
    useWalletMock.mockReturnValue({ publicKey: null });

    render(<UnshieldForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate proof & submit/i }));

    await waitFor(() => expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument());
    expect(requestProofMock).not.toHaveBeenCalled();
    expect(unshieldMock).not.toHaveBeenCalled();
  });

  it('submits an unshield request via the SDK', async () => {
    const publicKey = { toBase58: () => 'Wallet222222222222222222222222222222222222' };
    useWalletMock.mockReturnValue({ publicKey });

    requestProofMock.mockResolvedValue({
      proof: '0xproof',
      publicInputs: ['root', 'commitment', '0xfeed'],
      verifyingKeyHash: '0xvk'
    });
    resolvePublicKeyMock.mockResolvedValue(new PublicKey('Destination1111111111111111111111111111111'));
    unshieldMock.mockResolvedValue('tx-111');

    render(<UnshieldForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate proof & submit/i }));

    await waitFor(() => expect(unshieldMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith('unshield', expect.objectContaining({ mintId: expect.any(String) }));
    expect(resolvePublicKeyMock).toHaveBeenCalled();
    expect(screen.getByText(/Exit transaction sent/i)).toBeInTheDocument();
  });
});
