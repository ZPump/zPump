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
import { MINTS } from '../../config/mints';

const FAUCET_MODE = process.env.NEXT_PUBLIC_FAUCET_MODE ?? 'local';

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


