import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { UnwrapForm } from '../components/ptf/UnwrapForm';

const useWalletMock = jest.fn();
const requestProofMock = jest.fn();
const unwrapMock = jest.fn();
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
  unwrap: unwrapMock,
  resolvePublicKey: resolvePublicKeyMock
}));

describe('UnwrapForm', () => {
  beforeEach(() => {
    useWalletMock.mockReset();
    requestProofMock.mockReset();
    unwrapMock.mockReset();
    resolvePublicKeyMock.mockReset();
  });

  it('requires a connected wallet', async () => {
    useWalletMock.mockReturnValue({ publicKey: null });

    render(<UnwrapForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate unwrap proof & submit/i }));

    await waitFor(() => expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument());
    expect(requestProofMock).not.toHaveBeenCalled();
    expect(unwrapMock).not.toHaveBeenCalled();
  });

  it('submits an unwrap request via the SDK', async () => {
    const publicKey = { toBase58: () => 'Wallet222222222222222222222222222222222222' };
    useWalletMock.mockReturnValue({ publicKey });

    requestProofMock.mockResolvedValue({
      proof: '0xproof',
      publicInputs: ['root', 'commitment', '0xfeed'],
      verifyingKeyHash: '0xvk'
    });
    resolvePublicKeyMock.mockResolvedValue(new PublicKey('Destination1111111111111111111111111111111'));
    unwrapMock.mockResolvedValue('tx-111');

    render(<UnwrapForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate unwrap proof & submit/i }));

    await waitFor(() => expect(unwrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith('unwrap', expect.objectContaining({ mintId: expect.any(String) }));
    expect(resolvePublicKeyMock).toHaveBeenCalled();
    expect(screen.getByText(/Unwrap transaction sent/i)).toBeInTheDocument();
  });
});
