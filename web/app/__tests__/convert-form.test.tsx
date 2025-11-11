import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConvertForm } from '../components/ptf/ConvertForm';

const requestProofMock = jest.fn();
const wrapMock = jest.fn();
const unwrapMock = jest.fn();
const resolvePublicKeyMock = jest.fn();
const getRootsMock = jest.fn();
const getNullifiersMock = jest.fn();
const getNotesMock = jest.fn();

jest.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({
    connection: {
      getAccountInfo: jest.fn()
    }
  }),
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

jest.mock('../lib/indexerClient', () => ({
  IndexerClient: jest.fn().mockImplementation(() => ({
    getRoots: getRootsMock,
    getNullifiers: getNullifiersMock,
    getNotes: getNotesMock
  }))
}));

describe('ConvertForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
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
    getRootsMock.mockResolvedValue({
      mint: 'Mint111111111111111111111111111111111111111',
      current: '0xabc',
      recent: [],
      source: 'indexer'
    });
    getNullifiersMock.mockResolvedValue({
      mint: 'Mint111111111111111111111111111111111111111',
      nullifiers: ['0xdead'],
      source: 'indexer'
    });
    getNotesMock.mockResolvedValue({
      viewKey: 'vk',
      notes: [],
      source: 'indexer'
    });
  });

  it('submits a wrap flow when converting to private', async () => {
    render(<ConvertForm />);

    await waitFor(() => expect(getRootsMock).toHaveBeenCalled());
    await waitFor(() => expect(getNullifiersMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(wrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'wrap',
      expect.objectContaining({ amount: '5', depositId: expect.any(String), oldRoot: '0xabc' })
    );
    expect(screen.getByText(/Shielded 5 into z/)).toBeInTheDocument();
  });

  it('submits an unwrap flow when converting to public', async () => {
    render(<ConvertForm />);

    await waitFor(() => expect(getRootsMock).toHaveBeenCalled());
    await waitFor(() => expect(getNullifiersMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/Mode/i), { target: { value: 'to-public' } });
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(unwrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'unwrap',
      expect.objectContaining({ amount: '7', noteId: expect.any(String), oldRoot: '0xabc' })
    );
    expect(screen.getByText(/Redeemed 7/)).toBeInTheDocument();
  });
});

