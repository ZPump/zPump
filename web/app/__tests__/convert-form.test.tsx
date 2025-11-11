import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConvertForm } from '../components/ptf/ConvertForm';

const requestProofMock = jest.fn();
const wrapMock = jest.fn();
const unwrapMock = jest.fn();
const resolvePublicKeyMock = jest.fn();

jest.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: {} }),
  useWallet: () => ({
    publicKey: { toBase58: () => 'WALLET111' },
    sendTransaction: jest.fn().mockResolvedValue('sig111')
  })
}));

jest.mock('../lib/proofClient', () => ({
  ProofClient: jest.fn().mockImplementation(() => ({
    requestProof: requestProofMock
  }))
}));

jest.mock('../lib/sdk', () => ({
  wrap: (...args: unknown[]) => wrapMock(...args),
  unwrap: (...args: unknown[]) => unwrapMock(...args),
  resolvePublicKey: (...args: unknown[]) => resolvePublicKeyMock(...args)
}));

describe('ConvertForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wrapMock.mockResolvedValue('wrap-sig');
    unwrapMock.mockResolvedValue('unwrap-sig');
    resolvePublicKeyMock.mockResolvedValue({
      toBase58: () => 'DEST111'
    });
    requestProofMock.mockResolvedValue({
      proof: 'proof',
      publicInputs: ['1', '2', '3'],
      verifyingKeyHash: 'hash'
    });
  });

  it('submits a wrap flow when converting to private', async () => {
    render(<ConvertForm />);

    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(wrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'wrap',
      expect.objectContaining({ amount: '5', depositId: expect.any(String) })
    );
    expect(screen.getByText(/Shielded 5 into z/)).toBeInTheDocument();
  });

  it('submits an unwrap flow when converting to public', async () => {
    render(<ConvertForm />);

    fireEvent.change(screen.getByLabelText(/Mode/i), { target: { value: 'to-public' } });
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(unwrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'unwrap',
      expect.objectContaining({ amount: '7', noteId: expect.any(String) })
    );
    expect(screen.getByText(/Redeemed 7/)).toBeInTheDocument();
  });
});

