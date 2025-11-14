'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Flex,
  Code,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  NumberInput,
  NumberInputField,
  Select,
  Stack,
  Text,
  useBoolean,
  useToast
} from '@chakra-ui/react';
import { Droplet } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { MintConfig } from '../../config/mints';
import { useMintCatalog } from '../providers/MintCatalogProvider';

const FAUCET_MODE = process.env.NEXT_PUBLIC_FAUCET_MODE ?? 'local';
const SOL_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 6
});
const EVENT_REFRESH_INTERVAL = 5_000;
const FAUCET_STORAGE_KEY = 'zpump:faucet-events';

interface SharedFaucetEvent {
  type: 'sol' | 'token';
  signature: string;
  recipient: string;
  amount: string;
  mint: string | null;
  timestamp: number;
}

export function FaucetDashboard() {
  if (FAUCET_MODE !== 'local') {
    return (
      <Alert status="info" variant="left-accent">
        <AlertIcon />
        <AlertDescription>
          Faucet is disabled on this network. Set <code>NEXT_PUBLIC_FAUCET_MODE=local</code> and restart the web app to enable it.
        </AlertDescription>
      </Alert>
    );
  }
  return <LocalFaucetDashboard />;
}

function LocalFaucetDashboard() {
  const toast = useToast();
  const wallet = useWallet();
  const { connection } = useConnection();
  const { mints, loading: mintCatalogLoading, error: mintCatalogError, refresh: refreshMintCatalog } = useMintCatalog();
  const [solAmount, setSolAmount] = useState('1');
  const [tokenMint, setTokenMint] = useState<string>('');
  const [tokenAmount, setTokenAmount] = useState('100');
  const [isAirdropping, setAirdropping] = useBoolean(false);
  const [isMinting, setMinting] = useBoolean(false);
  const [isCreatingMint, setCreatingMint] = useBoolean(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [sharedEvents, setSharedEvents] = useState<SharedFaucetEvent[]>([]);
  const hasLoadedStoredEventsRef = useRef(false);
  const [newMintSymbol, setNewMintSymbol] = useState('');
  const [newMintDecimals, setNewMintDecimals] = useState('6');

  useEffect(() => {
    if (!tokenMint && mints.length > 0) {
      setTokenMint(mints[0].originMint);
    }
  }, [tokenMint, mints]);

  const refreshWalletBalance = useCallback(async () => {
    if (!wallet.publicKey) {
      setWalletBalance(null);
      return;
    }
    try {
      const lamports = await connection.getBalance(wallet.publicKey, { commitment: 'finalized' });
      console.info('[faucet] balance refresh', {
        wallet: wallet.publicKey.toBase58(),
        lamports,
        endpoint: connection.rpcEndpoint
      });
      setWalletBalance(lamports / LAMPORTS_PER_SOL);
    } catch (error) {
      console.error('[faucet] failed to refresh balance', error);
      setWalletBalance(null);
    }
  }, [connection, wallet.publicKey]);

  useEffect(() => {
    refreshWalletBalance();
  }, [refreshWalletBalance]);

  useEffect(() => {
    if (!wallet.publicKey) {
      return;
    }

    const interval = setInterval(() => {
      void refreshWalletBalance();
    }, 8_000);

    return () => {
      clearInterval(interval);
    };
  }, [wallet.publicKey, refreshWalletBalance]);

  useEffect(() => {
    if (hasLoadedStoredEventsRef.current) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(FAUCET_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as SharedFaucetEvent[];
        setSharedEvents(stored);
      }
    } catch (error) {
      console.warn('Unable to read cached faucet events', error);
    } finally {
      hasLoadedStoredEventsRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedStoredEventsRef.current || typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(FAUCET_STORAGE_KEY, JSON.stringify(sharedEvents));
    } catch (error) {
      console.warn('Unable to cache faucet events', error);
    }
  }, [sharedEvents]);

  const eventsAreEqual = useCallback((a: SharedFaucetEvent[], b: SharedFaucetEvent[]) => {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((event, index) => {
      const other = b[index];
      return (
        event.signature === other.signature &&
        event.timestamp === other.timestamp &&
        event.recipient === other.recipient &&
        event.amount === other.amount &&
        event.mint === other.mint &&
        event.type === other.type
      );
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchEvents = async () => {
      try {
        const response = await fetch('/api/faucet/events', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('failed_to_fetch_events');
        }
        const payload = (await response.json()) as { events: SharedFaucetEvent[] };
        if (!cancelled) {
          setSharedEvents((previous) =>
            eventsAreEqual(previous, payload.events) ? previous : payload.events
          );
          console.info('[faucet] fetched shared events', { count: payload.events.length });
        }
      } catch (error) {
        console.warn('[faucet] Unable to fetch faucet events', error);
      }
    };
    fetchEvents();
    const interval = setInterval(fetchEvents, EVENT_REFRESH_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [eventsAreEqual]);

  const selectedMint = useMemo(
    () => mints.find((mint) => mint.originMint === tokenMint),
    [mints, tokenMint]
  );

  const handleSolAirdrop = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!wallet.publicKey) {
      toast({ title: 'Connect a wallet to request SOL', status: 'error' });
      return;
    }

    let lamports: bigint;
    try {
      lamports = parseSolAmount(solAmount);
    } catch (error) {
      toast({ title: (error as Error).message, status: 'error' });
      return;
    }

    setAirdropping.on();
    try {
      const response = await fetch('/api/faucet/sol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: wallet.publicKey.toBase58(),
          amountLamports: lamports.toString()
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { signature?: string; error?: string };
      const signature = payload.signature ?? 'unknown';
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to request SOL airdrop');
      }
      await refreshWalletBalance();
      console.info('[faucet] SOL airdrop success', {
        signature,
        lamports: lamports.toString(),
        recipient: wallet.publicKey.toBase58()
      });
      toast({
        title: 'SOL airdrop submitted',
        description: `Signature: ${signature}`,
        status: 'success',
        duration: 4000,
        isClosable: true
      });
    } catch (error) {
      toast({
        title: 'Unable to request SOL airdrop',
        description: (error as Error).message,
        status: 'error'
      });
    } finally {
      setAirdropping.off();
    }
  };

  const handleTokenMint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!wallet.publicKey) {
      toast({ title: 'Connect a wallet to mint tokens', status: 'error' });
      return;
    }
    if (!selectedMint) {
      toast({ title: 'No origin mints configured', status: 'error' });
      return;
    }

    let amount: bigint;
    try {
      amount = parseTokenAmount(tokenAmount, selectedMint.decimals);
    } catch (error) {
      toast({ title: (error as Error).message, status: 'error' });
      return;
    }

    setMinting.on();
    try {
      const response = await fetch('/api/faucet/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: wallet.publicKey.toBase58(),
          mint: selectedMint.originMint,
          amount: amount.toString()
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { signature?: string; error?: string };
      const signature = payload.signature ?? 'unknown';
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to mint tokens');
      }
      await refreshWalletBalance();
      console.info('[faucet] token mint success', {
        signature,
        amount: amount.toString(),
        mint: selectedMint.originMint,
        recipient: wallet.publicKey.toBase58()
      });
      toast({
        title: `${selectedMint.symbol} minted`,
        description: `Signature: ${signature}`,
        status: 'success',
        duration: 4000,
        isClosable: true
      });
    } catch (error) {
      toast({
        title: 'Unable to mint tokens',
        description: (error as Error).message,
        status: 'error'
      });
    } finally {
      setMinting.off();
    }
  };

  const handleMintRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const symbol = newMintSymbol.trim().toUpperCase();
    if (!symbol) {
      toast({ title: 'Enter a mint symbol', status: 'error' });
      return;
    }
    const decimals = Number.parseInt(newMintDecimals, 10);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
      toast({ title: 'Decimals must be between 0 and 9', status: 'error' });
      return;
    }
    setCreatingMint.on();
    try {
      const response = await fetch('/api/mints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, decimals })
      });
      const payload = (await response.json().catch(() => ({}))) as { mint?: MintConfig; error?: string };
      if (!response.ok || !payload.mint) {
        throw new Error(payload.error ?? 'Mint registration failed');
      }
      toast({
        title: `${payload.mint.symbol} registered`,
        description: `Origin mint: ${payload.mint.originMint}`,
        status: 'success',
        duration: 5000,
        isClosable: true
      });
      setNewMintSymbol('');
      setNewMintDecimals(payload.mint.decimals.toString());
      await refreshMintCatalog();
      setTokenMint(payload.mint.originMint);
    } catch (error) {
      toast({
        title: 'Unable to register mint',
        description: (error as Error).message,
        status: 'error'
      });
    } finally {
      setCreatingMint.off();
    }
  };

  return (
    <Stack spacing={8}>
      <Stack spacing={2}>
        <Heading size="2xl">Faucet</Heading>
        <Text color="whiteAlpha.700">
          Request SOL and mint origin tokens directly against your local Solana devnet.
        </Text>
      </Stack>

      {!wallet.publicKey && (
        <Alert status="warning" variant="left-accent">
          <AlertIcon />
          <AlertDescription>Connect a wallet to receive funds from the local faucet.</AlertDescription>
        </Alert>
      )}

      {mintCatalogError && (
        <Alert status="error" variant="left-accent">
          <AlertIcon />
          <AlertDescription>
            Unable to load the mint catalogue. {mintCatalogError}. Try refreshing or running the bootstrap script again.
          </AlertDescription>
        </Alert>
      )}

      <Stack spacing={6}>
        <Box
          as="form"
          onSubmit={handleSolAirdrop}
          bg="rgba(18, 16, 14, 0.9)"
          border="1px solid rgba(245,178,27,0.24)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(245, 178, 27, 0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Request SOL</Heading>
            <FormControl>
              <FormLabel color="whiteAlpha.700">Amount (SOL)</FormLabel>
              <NumberInput min={0} precision={3} value={solAmount} onChange={(value) => setSolAmount(value)}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText color="whiteAlpha.500">
                Defaults to 1 SOL. Airdrops come directly from the local Solana devnet.
              </FormHelperText>
            </FormControl>
            <Button type="submit" leftIcon={<Droplet size={16} />} isLoading={isAirdropping} isDisabled={!wallet.publicKey}>
              Airdrop SOL
            </Button>
          </Stack>
        </Box>

        <Box
          as="form"
          onSubmit={handleTokenMint}
          bg="rgba(18, 16, 14, 0.9)"
          border="1px solid rgba(245,178,27,0.24)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(245, 178, 27, 0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Mint origin tokens</Heading>
            <FormControl isDisabled={mints.length === 0 || mintCatalogLoading}>
              <FormLabel color="whiteAlpha.700">Origin mint</FormLabel>
              <Select value={tokenMint || '__none'} onChange={(event) => setTokenMint(event.target.value)}>
                {mints.map((mint) => (
                  <option key={mint.originMint} value={mint.originMint}>
                    {mint.symbol} — {mint.originMint}
                  </option>
                ))}
                {(!mints.length || mintCatalogLoading) && (
                  <option value="__none" disabled>
                    {mintCatalogLoading ? 'Loading...' : 'No tokens available'}
                  </option>
                )}
              </Select>
              <FormHelperText color="whiteAlpha.500">
                Tokens come from the bootstrap mint authority. Ensure the origin mint is registered locally.
              </FormHelperText>
            </FormControl>
            <FormControl>
              <FormLabel color="whiteAlpha.700">
                Amount ({selectedMint ? selectedMint.symbol : 'TOKEN'})
              </FormLabel>
              <NumberInput
                min={0}
                precision={selectedMint?.decimals ?? 6}
                value={tokenAmount}
                onChange={(value) => setTokenAmount(value)}
              >
                <NumberInputField />
              </NumberInput>
              {selectedMint && (
                <FormHelperText color="whiteAlpha.500">
                  {selectedMint.decimals} decimal places supported. Values are minted directly to your wallet ATA.
                </FormHelperText>
              )}
            </FormControl>
            <Button
              type="submit"
              leftIcon={<Droplet size={16} />}
              isLoading={isMinting}
              isDisabled={!wallet.publicKey || !mints.length}
            >
              Mint tokens
            </Button>
          </Stack>
        </Box>

        <Box
          as="form"
          onSubmit={handleMintRegistration}
          bg="rgba(18, 16, 14, 0.9)"
          border="1px solid rgba(245,178,27,0.24)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(245, 178, 27, 0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Register a new origin mint</Heading>
            <FormControl isRequired>
              <FormLabel color="whiteAlpha.700">Symbol</FormLabel>
              <Input
                value={newMintSymbol}
                onChange={(event) => setNewMintSymbol(event.target.value.toUpperCase())}
                placeholder="e.g. GOLD"
              />
              <FormHelperText color="whiteAlpha.500">2–6 uppercase characters.</FormHelperText>
            </FormControl>
            <FormControl>
              <FormLabel color="whiteAlpha.700">Decimals</FormLabel>
              <NumberInput
                min={0}
                max={9}
                value={newMintDecimals}
                onChange={(value) => setNewMintDecimals(value)}
                clampValueOnBlur
              >
                <NumberInputField />
              </NumberInput>
              <FormHelperText color="whiteAlpha.500">
                Each mint spins up its own pool, vault, and commitment tree automatically.
              </FormHelperText>
            </FormControl>
            <Button type="submit" leftIcon={<Droplet size={16} />} isLoading={isCreatingMint}>
              Create mint + pool
            </Button>
            <Alert status="info" variant="subtle">
              <AlertIcon />
              <AlertDescription>
                The devnet bootstrap runs behind the scenes. This can take up to a minute the first time.
              </AlertDescription>
            </Alert>
          </Stack>
        </Box>
      </Stack>

      <Stack spacing={4}>
        {sharedEvents.length > 0 && (
        <Box
          bg="rgba(20, 18, 14, 0.82)"
          border="1px solid rgba(245,178,27,0.18)"
          rounded="2xl"
          p={{ base: 5, md: 6 }}
        >
          <Stack spacing={3}>
            <Heading size="sm">Latest faucet activity</Heading>
            <Flex direction="column" gap={2} maxH="220px" overflowY="auto">
              {sharedEvents.map((event) => (
                <Flex
                  key={`${event.signature}-${event.timestamp}`}
                  direction="column"
                  gap={1}
                  bg="rgba(24, 20, 16, 0.9)"
                  border="1px solid rgba(245,178,27,0.2)"
                  rounded="lg"
                  px={4}
                  py={3}
                >
                  <Flex justify="space-between" align="center">
                    <Text fontSize="sm" fontWeight="semibold" color="whiteAlpha.800">
                      {event.type === 'sol'
                        ? `${SOL_FORMATTER.format(Number(event.amount) / LAMPORTS_PER_SOL)} SOL`
                        : `${event.amount} ${event.mint ?? ''}`}
                    </Text>
                    <Text fontSize="xs" color="whiteAlpha.500">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </Text>
                  </Flex>
                  <Text fontSize="xs" color="whiteAlpha.600">
                    Recipient {event.recipient}
                  </Text>
                  <Code fontSize="xs" wordBreak="break-all">
                    {event.signature}
                  </Code>
                </Flex>
              ))}
            </Flex>
          </Stack>
        </Box>
        )}
      </Stack>
    </Stack>
  );
}

function parseSolAmount(amount: string): bigint {
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error('Enter an amount of SOL to airdrop.');
  }
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid SOL amount.');
  }
  const lamports = BigInt(Math.round(value * LAMPORTS_PER_SOL));
  if (lamports <= 0n) {
    throw new Error('Invalid SOL amount.');
  }
  return lamports;
}

function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error('Enter an amount to mint.');
  }
  if (!/^\d+(\.\d+)?$/u.test(trimmed)) {
    throw new Error('Amount must be numeric.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places.`);
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  const combined = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/u, '');
  const baseUnits = combined.length > 0 ? BigInt(combined) : 0n;
  if (baseUnits <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return baseUnits;
}



