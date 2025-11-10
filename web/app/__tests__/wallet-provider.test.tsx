import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { WalletProvider } from '../components/providers/WalletProvider';

const connectionProviderSpy = jest.fn(({ children, endpoint, config }: PropsWithChildren<{ endpoint: string; config?: { commitment: string } }>) => (
  <div data-testid="connection" data-endpoint={endpoint} data-commitment={config?.commitment}>
    {children}
  </div>
));

const walletProviderSpy = jest.fn(({ children }: PropsWithChildren) => <div data-testid="wallet">{children}</div>);

jest.mock('@solana/wallet-adapter-react', () => ({
  ConnectionProvider: (props: any) => connectionProviderSpy(props),
  WalletProvider: (props: any) => walletProviderSpy(props),
  useWallet: () => ({ connected: false, disconnect: jest.fn(), publicKey: { toBase58: () => 'wallet' } })
}));

jest.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: PropsWithChildren) => <div data-testid="modal">{children}</div>,
  useWalletModal: () => ({ setVisible: jest.fn() })
}));

jest.mock('@solana/web3.js', () => ({
  clusterApiUrl: () => 'https://devnet.solana.com'
}));

describe('WalletProvider', () => {
  beforeEach(() => {
    connectionProviderSpy.mockClear();
    walletProviderSpy.mockClear();
  });

  it('uses provided RPC endpoint when env is set', () => {
    process.env.NEXT_PUBLIC_RPC_URL = 'https://example-rpc.solana.com';

    render(
      <WalletProvider>
        <div>child</div>
      </WalletProvider>
    );

    expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', 'https://example-rpc.solana.com');
    expect(screen.getByTestId('connection')).toHaveAttribute('data-commitment', 'confirmed');
  });

  it('falls back to devnet RPC when env unset', () => {
    delete process.env.NEXT_PUBLIC_RPC_URL;

    render(
      <WalletProvider>
        <div>child</div>
      </WalletProvider>
    );

    expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', 'https://devnet.solana.com');
  });
});
