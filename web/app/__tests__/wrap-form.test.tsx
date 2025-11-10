import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WrapForm } from '../components/ptf/WrapForm';

const useWalletMock = jest.fn();
const requestProofMock = jest.fn();
const wrapMock = jest.fn();

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
  wrap: wrapMock
}));

describe('WrapForm', () => {
  beforeEach(() => {
    useWalletMock.mockReset();
    requestProofMock.mockReset();
    wrapMock.mockReset();
  });

  it('requires a connected wallet', async () => {
    useWalletMock.mockReturnValue({ publicKey: null });

    render(<WrapForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate wrap proof & submit/i }));

    await waitFor(() => expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument());
    expect(requestProofMock).not.toHaveBeenCalled();
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it('requests a proof and submits the transaction', async () => {
    const publicKey = { toBase58: () => 'Wallet111111111111111111111111111111111111' };
    useWalletMock.mockReturnValue({ publicKey });

    requestProofMock.mockResolvedValue({
      proof: '0xproof',
      publicInputs: ['root', 'commitment', '0xfeed'],
      verifyingKeyHash: '0xvk'
    });
    wrapMock.mockResolvedValue('signature111');

    render(<WrapForm />);

    fireEvent.click(screen.getByRole('button', { name: /Generate wrap proof & submit/i }));

    await waitFor(() => expect(wrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith('wrap', expect.objectContaining({ mintId: expect.any(String) }));
    expect(screen.getByText(/Wrap transaction sent/i)).toBeInTheDocument();
  });
});
