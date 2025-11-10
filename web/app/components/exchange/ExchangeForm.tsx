'use client';

import {
  Box,
  Button,
  FormControl,
  FormLabel,
  HStack,
  NumberInput,
  NumberInputField,
  Select,
  Stack,
  Text,
  useBoolean
} from '@chakra-ui/react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useState } from 'react';

const MOCK_TOKENS = [
  { label: 'USDC', mint: 'So11111111111111111111111111111111111111112', wrappedMint: 'zUSDC1111111111111111111111111111111111111' },
  { label: 'BONK', mint: 'Bonk111111111111111111111111111111111111111', wrappedMint: 'zBONK111111111111111111111111111111111111' }
];

export type ExchangeMode = 'wrap' | 'unwrap-origin' | 'unwrap-ztoken';

export function ExchangeForm() {
  const { connected } = useWallet();
  const [tokenMint, setTokenMint] = useState(MOCK_TOKENS[0].mint);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<ExchangeMode>('wrap');
  const [isSubmitting, setIsSubmitting] = useBoolean();

  const selectedToken = MOCK_TOKENS.find((token) => token.mint === tokenMint) ?? MOCK_TOKENS[0];

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting.on();

    await new Promise((resolve) => setTimeout(resolve, 800));

    setIsSubmitting.off();
  };

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      bg="rgba(10, 14, 30, 0.8)"
      p={{ base: 6, md: 10 }}
      rounded="3xl"
      border="1px solid rgba(59,205,255,0.25)"
      boxShadow="0 0 45px rgba(59,205,255,0.25)"
    >
      <Stack spacing={6}>
        <FormControl>
          <FormLabel color="whiteAlpha.700">Mode</FormLabel>
          <Select value={mode} onChange={(event) => setMode(event.target.value as ExchangeMode)} bg="rgba(6, 10, 26, 0.85)">
            <option value="wrap">Wrap into zTokens</option>
            <option value="unwrap-origin">Unwrap to Origin Mint</option>
            <option value="unwrap-ztoken">Unwrap into fresh zTokens</option>
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel color="whiteAlpha.700">Token</FormLabel>
          <Select value={tokenMint} onChange={(event) => setTokenMint(event.target.value)} bg="rgba(6, 10, 26, 0.85)">
            {MOCK_TOKENS.map((token) => (
              <option key={token.mint} value={token.mint}>
                {token.label}
              </option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel color="whiteAlpha.700">Amount</FormLabel>
          <NumberInput min={0} value={amount} onChange={(valueString) => setAmount(valueString)}>
            <NumberInputField placeholder="0.00" />
          </NumberInput>
        </FormControl>
        <Box bg="rgba(4, 8, 20, 0.95)" rounded="xl" p={4} border="1px solid rgba(59,205,255,0.15)">
          <Text fontSize="sm" color="whiteAlpha.600">
            Wrapped counterpart:
          </Text>
          <HStack justify="space-between" mt={2}>
            <Text fontSize="sm" color="brand.200">
              {selectedToken.wrappedMint}
            </Text>
            <Button size="xs" variant="outline" onClick={() => navigator.clipboard.writeText(selectedToken.wrappedMint)}>
              Copy
            </Button>
          </HStack>
        </Box>
        <Button
          type="submit"
          size="lg"
          variant="glow"
          isDisabled={!connected || !amount}
          isLoading={isSubmitting}
          loadingText="Simulating"
        >
          {connected ? 'Simulate Exchange' : 'Connect wallet to proceed'}
        </Button>
      </Stack>
    </Box>
  );
}
