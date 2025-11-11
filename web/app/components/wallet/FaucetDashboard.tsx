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
  useToast
} from '@chakra-ui/react';
import { Droplet } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import { SOL_TOKEN_ID } from '../../lib/simulation/constants';
import { SimTransaction } from '../../lib/simulation/types';

export function FaucetDashboard() {
  const toast = useToast();
  const { ready, activeAccount, tokens, incrementBalance, recordTransaction } = useSimulation();

  const [solAmount, setSolAmount] = useState('5');
  const [tokenId, setTokenId] = useState<string>(SOL_TOKEN_ID);
  const [tokenAmount, setTokenAmount] = useState('100');

  const tokenOptions = useMemo(() => tokens.filter((token) => token.id !== SOL_TOKEN_ID), [tokens]);

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

