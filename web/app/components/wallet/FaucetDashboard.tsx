'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  NumberInput,
  NumberInputField,
  Select,
  Stack,
  Text,
  useBoolean,
  useToast
} from '@chakra-ui/react';
import { Droplet } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSimulation } from '../../hooks/useSimulation';
import { SOL_TOKEN_ID } from '../../lib/simulation/constants';
import { SimTransaction } from '../../lib/simulation/types';
import { MINTS } from '../../config/mints';

const FAUCET_MODE = process.env.NEXT_PUBLIC_FAUCET_MODE ?? 'simulation';

export function FaucetDashboard() {
  if (FAUCET_MODE === 'local') {
    return <LocalFaucetDashboard />;
  }
  if (FAUCET_MODE === 'simulation') {
    return <SimulationFaucetDashboard />;
  }
  return (
    <Alert status="info" variant="left-accent">
      <AlertIcon />
      <AlertDescription>
        Faucet is disabled on this network. Use the native SOL faucet or existing token balances.
      </AlertDescription>
    </Alert>
  );
}

function LocalFaucetDashboard() {
  const toast = useToast();
  const wallet = useWallet();
  const [solAmount, setSolAmount] = useState('1');
  const [tokenMint, setTokenMint] = useState<string>(MINTS[0]?.originMint ?? '');
  const [tokenAmount, setTokenAmount] = useState('100');
  const [isAirdropping, setAirdropping] = useBoolean(false);
  const [isMinting, setMinting] = useBoolean(false);

  useEffect(() => {
    if (!tokenMint && MINTS.length > 0) {
      setTokenMint(MINTS[0].originMint);
    }
  }, [tokenMint]);

  const selectedMint = useMemo(
    () => MINTS.find((mint) => mint.originMint === tokenMint),
    [tokenMint]
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
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to request SOL airdrop');
      }
      toast({
        title: 'SOL airdrop submitted',
        description: `Signature: ${payload.signature}`,
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
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to mint tokens');
      }
      toast({
        title: `${selectedMint.symbol} minted`,
        description: `Signature: ${payload.signature}`,
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

  return (
    <Stack spacing={8}>
      <Stack spacing={2}>
        <Heading size="2xl">Local validator faucet</Heading>
        <Text color="whiteAlpha.700">
          Request SOL and mint origin tokens directly against your local Solana validator. Connect a wallet and run the
          bootstrap script before using this faucet.
        </Text>
      </Stack>

      {!wallet.publicKey && (
        <Alert status="warning" variant="left-accent">
          <AlertIcon />
          <AlertDescription>Connect a wallet to receive funds from the local faucet.</AlertDescription>
        </Alert>
      )}

      <Stack spacing={6}>
        <Box
          as="form"
          onSubmit={handleSolAirdrop}
          bg="rgba(10, 14, 30, 0.85)"
          border="1px solid rgba(59,205,255,0.25)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(59,205,255,0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Request SOL</Heading>
            <FormControl>
              <FormLabel color="whiteAlpha.700">Amount (SOL)</FormLabel>
              <NumberInput min={0} precision={3} value={solAmount} onChange={(value) => setSolAmount(value)}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText color="whiteAlpha.500">
                Defaults to 1 SOL. Airdrops come directly from the local validator.
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
          bg="rgba(10, 14, 30, 0.85)"
          border="1px solid rgba(59,205,255,0.25)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(59,205,255,0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Mint origin tokens</Heading>
            <FormControl isDisabled={MINTS.length === 0}>
              <FormLabel color="whiteAlpha.700">Origin mint</FormLabel>
              <Select value={tokenMint} onChange={(event) => setTokenMint(event.target.value)}>
                {MINTS.map((mint) => (
                  <option key={mint.originMint} value={mint.originMint}>
                    {mint.symbol} — {mint.originMint}
                  </option>
                ))}
              </Select>
              <FormHelperText color="whiteAlpha.500">
                Tokens come from the bootstrap mint authority. Ensure the origin mint is registered locally.
              </FormHelperText>
            </FormControl>
            <FormControl>
              <FormLabel color="whiteAlpha.700">
                Amount ({selectedMint ? selectedMint.symbol : 'TOKEN'})
              </FormLabel>
              <NumberInput min={0} precision={selectedMint?.decimals ?? 6} value={tokenAmount} onChange={(value) => setTokenAmount(value)}>
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
              isDisabled={!wallet.publicKey || MINTS.length === 0}
            >
              Mint tokens
            </Button>
          </Stack>
        </Box>
      </Stack>
    </Stack>
  );
}

function SimulationFaucetDashboard() {
  const toast = useToast();
  const { ready, activeAccount, tokens, incrementBalance, recordTransaction } = useSimulation();

  const [solAmount, setSolAmount] = useState('5');
  const [tokenId, setTokenId] = useState<string>(SOL_TOKEN_ID);
  const [tokenAmount, setTokenAmount] = useState('100');

  const tokenOptions = useMemo(
    () => tokens.filter((token) => token.id !== SOL_TOKEN_ID),
    [tokens]
  );

  useEffect(() => {
    if (tokenOptions.length > 0 && !tokenOptions.some((token) => token.id === tokenId)) {
      setTokenId(tokenOptions[0].id);
    }
  }, [tokenOptions, tokenId]);

  if (!ready) {
    return null;
  }

  if (!activeAccount) {
    return (
      <Alert status="info" variant="left-accent">
        <AlertIcon />
        <AlertDescription>Select or create a simulation account before using the faucet.</AlertDescription>
      </Alert>
    );
  }

  const handleSolAirdrop = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number.parseFloat(solAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast({ title: 'Invalid amount', status: 'error' });
      return;
    }
    incrementBalance(activeAccount.id, SOL_TOKEN_ID, parsed.toString());
    const transaction: SimTransaction = {
      id: crypto.randomUUID(),
      to: activeAccount.publicKey,
      tokenId: SOL_TOKEN_ID,
      amount: parsed.toString(),
      timestamp: Date.now(),
      type: 'airdrop'
    };
    recordTransaction(transaction);
    toast({
      title: 'SOL airdropped',
      description: `${parsed} test SOL added to ${activeAccount.label}.`,
      status: 'success',
      duration: 3000,
      isClosable: true
    });
  };

  const handleTokenMint = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number.parseFloat(tokenAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast({ title: 'Invalid amount', status: 'error' });
      return;
    }
    incrementBalance(activeAccount.id, tokenId, parsed.toString());

    const transaction: SimTransaction = {
      id: crypto.randomUUID(),
      to: activeAccount.publicKey,
      tokenId,
      amount: parsed.toString(),
      timestamp: Date.now(),
      type: 'mint'
    };
    recordTransaction(transaction);
    const token = tokens.find((entry) => entry.id === tokenId);
    toast({
      title: `${token?.symbol ?? 'Token'} minted`,
      description: `${parsed} ${token?.symbol ?? ''} credited to ${activeAccount.label}.`,
      status: 'success',
      duration: 3000,
      isClosable: true
    });
  };

  return (
    <Stack spacing={8}>
      <Stack spacing={2}>
        <Heading size="2xl">Simulation faucet</Heading>
        <Text color="whiteAlpha.700">
          Top up SOL and mint origin or zTokens directly into your local simulation accounts. No phantom or ledger required.
        </Text>
      </Stack>

      <Stack spacing={6}>
        <Box
          as="form"
          onSubmit={handleSolAirdrop}
          bg="rgba(10, 14, 30, 0.85)"
          border="1px solid rgba(59,205,255,0.25)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(59,205,255,0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Request test SOL</Heading>
            <FormControl>
              <FormLabel color="whiteAlpha.700">Amount</FormLabel>
              <NumberInput min={0} precision={3} value={solAmount} onChange={(value) => setSolAmount(value)}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText color="whiteAlpha.500">
                SOL powers transaction fees in the simulation. Add as much as you need to explore flows.
              </FormHelperText>
            </FormControl>
            <Button type="submit" leftIcon={<Droplet size={16} />}>
              Airdrop SOL
            </Button>
          </Stack>
        </Box>

        <Box
          as="form"
          onSubmit={handleTokenMint}
          bg="rgba(10, 14, 30, 0.85)"
          border="1px solid rgba(59,205,255,0.25)"
          rounded="3xl"
          p={{ base: 6, md: 8 }}
          boxShadow="0 0 35px rgba(59,205,255,0.2)"
        >
          <Stack spacing={4}>
            <Heading size="md">Mint origin or zTokens</Heading>
            <FormControl isDisabled={tokenOptions.length === 0}>
              <FormLabel color="whiteAlpha.700">Token</FormLabel>
              <Select
                value={tokenId}
                onChange={(event) => setTokenId(event.target.value)}
                placeholder={tokenOptions.length === 0 ? 'No origin mints configured' : undefined}
              >
                {tokenOptions.map((token) => (
                  <option key={token.id} value={token.id}>
                    {token.symbol} — {token.displayName}
                  </option>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel color="whiteAlpha.700">Amount</FormLabel>
              <NumberInput min={0} precision={6} value={tokenAmount} onChange={(value) => setTokenAmount(value)}>
                <NumberInputField />
              </NumberInput>
              <FormHelperText color="whiteAlpha.500">
                Mint directly into the active account. Use the wallet dashboard to transfer between simulation accounts.
              </FormHelperText>
            </FormControl>
            <Button type="submit" leftIcon={<Droplet size={16} />} isDisabled={tokenOptions.length === 0}>
              Mint tokens
            </Button>
          </Stack>
        </Box>
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


