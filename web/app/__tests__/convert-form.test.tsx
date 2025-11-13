import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ConvertForm } from '../components/ptf/ConvertForm';
import { renderWithProviders } from '../test-utils/renderWithProviders';

const requestProofMock = jest.fn();
const wrapMock = jest.fn();
const unwrapMock = jest.fn();
const resolvePublicKeyMock = jest.fn();
const getRootsMock = jest.fn();
const getNullifiersMock = jest.fn();
const getNotesMock = jest.fn();
const getAccountInfoMock = jest.fn();
const appendNullifiersMock = jest.fn();

const mockConnection = {
  getAccountInfo: getAccountInfoMock
};

const mockWallet = {
  publicKey: { toBase58: () => 'WALLET111' },
  sendTransaction: jest.fn().mockResolvedValue('sig111')
};

jest.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({
    connection: mockConnection
  }),
  useWallet: () => mockWallet
}));

jest.mock('@solana/web3.js', () => {
  class MockPublicKey {
    private readonly value: string;

    constructor(value: string) {
      this.value = value || '11111111111111111111111111111111';
    }

    toBase58(): string {
      return this.value;
    }

    toBuffer(): Buffer {
      return Buffer.alloc(32);
    }

    equals(other: MockPublicKey): boolean {
      return other?.toBase58?.() === this.value;
    }
  }

  return { PublicKey: MockPublicKey };
});

jest.mock('../lib/proofClient', () => ({
  ProofClient: jest.fn().mockImplementation(() => ({
    requestProof: requestProofMock
  }))
}));

jest.mock('../lib/onchain/poseidon', () => ({
  poseidonHashMany: jest.fn().mockResolvedValue(new Uint8Array(32))
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
    getNotes: getNotesMock,
    appendNullifiers: appendNullifiersMock
  }))
}));

describe('ConvertForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAccountInfoMock.mockReset();
    getAccountInfoMock.mockResolvedValue(null);
    mockWallet.sendTransaction.mockResolvedValue('sig111');
    window.localStorage.clear();
    wrapMock.mockResolvedValue('wrap-sig');
    unwrapMock.mockResolvedValue('unwrap-sig');
    appendNullifiersMock.mockResolvedValue(undefined);
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
    renderWithProviders(<ConvertForm />);

    await waitFor(() => expect(getRootsMock).toHaveBeenCalled());
    await waitFor(() => expect(getNullifiersMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(wrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'wrap',
      expect.objectContaining({ amount: '5000000', depositId: expect.any(String), oldRoot: '0xabc' })
    );
    expect(wrapMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000000n }));
    expect(screen.getByText(/Shielded 5 into z/)).toBeInTheDocument();
  });

  it('submits an unwrap flow when converting to public', async () => {
    renderWithProviders(<ConvertForm />);

    await waitFor(() => expect(getRootsMock).toHaveBeenCalled());
    await waitFor(() => expect(getNullifiersMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/Mode/i), { target: { value: 'to-public' } });
    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit conversion/i }));

    await waitFor(() => expect(unwrapMock).toHaveBeenCalledTimes(1));
    expect(requestProofMock).toHaveBeenCalledWith(
      'unwrap',
      expect.objectContaining({
        amount: '7000000',
        noteAmount: '7000000',
        fee: '0',
        noteId: expect.any(String),
        oldRoot: '0xabc'
      })
    );
    expect(unwrapMock).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7000000n })
    );
    await waitFor(() => expect(appendNullifiersMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Redeemed 7/)).toBeInTheDocument();
  });
});

