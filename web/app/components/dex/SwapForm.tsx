'use client';

import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  IconButton,
  Input,
  InputGroup,
  InputRightElement,
  Stack,
  Text,
  useBoolean,
  VStack,
  Alert,
  AlertIcon,
  AlertDescription,
  Spinner
} from '@chakra-ui/react';
import { ArrowDownUp, ArrowUpDown } from 'lucide-react';
import { TokenSelector } from './TokenSelector';
import { useState, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useMintCatalog } from '../providers/MintCatalogProvider';
import { 
  swapDex, 
  getDexPoolState, 
  calculateSwapOutput,
  isZToken 
} from '../../lib/sdk';
import { formatBaseUnitsToUi } from '../../lib/format';

const AMOUNT_INPUT_PATTERN = /^\d*(?:\.\d*)?$/;

function normaliseAmountInput(value: string): string {
  let trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('.')) trimmed = `0${trimmed}`;
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

interface SwapFormProps {
  onTokenChange?: (tokenA: string, tokenB: string) => void;
}

/**
 * SwapForm component for DEX swaps
 * Handles all 4 swap types:
 * - Public → Public
 * - zToken → zToken
 * - Public → zToken
 * - zToken → Public
 */
export function SwapForm({ onTokenChange }: SwapFormProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { mints } = useMintCatalog();
  
  const [tokenA, setTokenA] = useState<string>('');
  const [tokenB, setTokenB] = useState<string>('');
  
  // Notify parent of token changes
  useEffect(() => {
    if (onTokenChange) {
      onTokenChange(tokenA, tokenB);
    }
  }, [tokenA, tokenB, onTokenChange]);
  const [amountIn, setAmountIn] = useState<string>('');
  const [isSubmitting, setSubmitting] = useBoolean(false);
  const [error, setError] = useState<string | null>(null);
  const [poolState, setPoolState] = useState<any>(null);
  const [loadingPool, setLoadingPool] = useBoolean(false);
  
  // Calculate swap direction
  const aToB = useMemo(() => {
    if (!tokenA || !tokenB) return true;
    try {
      const aKey = new PublicKey(tokenA);
      const bKey = new PublicKey(tokenB);
      return aKey.toBuffer().compare(bKey.toBuffer()) < 0;
    } catch {
      return true;
    }
  }, [tokenA, tokenB]);
  
  // Fetch pool state when tokens change
  useEffect(() => {
    if (!tokenA || !tokenB || !connection) return;
    
    const fetchPool = async () => {
      setLoadingPool.on();
      setError(null);
      try {
        const pool = await getDexPoolState(
          connection,
          new PublicKey(tokenA),
          new PublicKey(tokenB)
        );
        setPoolState(pool);
      } catch (err) {
        // Pool doesn't exist yet - that's okay
        setPoolState(null);
      } finally {
        setLoadingPool.off();
      }
    };
    
    void fetchPool();
  }, [tokenA, tokenB, connection, setLoadingPool]);
  
  // Calculate output amount
  const outputAmount = useMemo(() => {
    if (!amountIn || !poolState || !tokenA || !tokenB) return null;
    
    try {
      const amountInBigInt = BigInt(amountIn.replace('.', ''));
      const reserveIn = aToB ? poolState.publicReserveA : poolState.publicReserveB;
      const reserveOut = aToB ? poolState.publicReserveB : poolState.publicReserveA;
      
      if (reserveIn === 0n || reserveOut === 0n) return null;
      
      const output = calculateSwapOutput(amountInBigInt, reserveIn, reserveOut, 5);
      return output;
    } catch {
      return null;
    }
  }, [amountIn, poolState, tokenA, tokenB, aToB]);
  
  const handleSwap = async () => {
    if (!wallet.connected || !tokenA || !tokenB || !amountIn || !poolState) {
      setError('Please fill in all fields and ensure pool exists');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      const amountInBigInt = BigInt(amountIn.replace('.', ''));
      const minAmountOut = outputAmount ? (outputAmount * 95n) / 100n : 0n; // 5% slippage
      
      const signature = await swapDex({
        connection,
        wallet: wallet as any,
        tokenA,
        tokenB,
        amountIn: amountInBigInt,
        minAmountOut,
        aToB
      });
      
      setError(null);
      // TODO: Show success toast
      console.log('Swap successful:', signature);
    } catch (err: any) {
      setError(err.message || 'Swap failed');
    } finally {
      setSubmitting.off();
    }
  };
  
  const swapTokens = () => {
    const temp = tokenA;
    setTokenA(tokenB);
    setTokenB(temp);
  };
  
  return (
    <VStack spacing={4} align="stretch">
      <Heading size="md">Swap Tokens</Heading>
      
      {error && (
        <Alert status="error">
          <AlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      
      <FormControl>
        <FormLabel>From</FormLabel>
        <TokenSelector
          value={tokenA}
          onChange={setTokenA}
          placeholder="Select or paste token A mint"
          excludeMint={tokenB}
        />
      </FormControl>
      
      <Box position="relative" display="flex" justifyContent="center">
        <IconButton
          aria-label="Swap tokens"
          icon={<ArrowUpDown />}
          onClick={swapTokens}
          size="sm"
          variant="outline"
        />
      </Box>
      
      <FormControl>
        <FormLabel>To</FormLabel>
        <TokenSelector
          value={tokenB}
          onChange={setTokenB}
          placeholder="Select or paste token B mint"
          excludeMint={tokenA}
        />
      </FormControl>
      
      <FormControl>
        <FormLabel>Amount In</FormLabel>
        <Input
          type="text"
          placeholder="0.0"
          value={amountIn}
          onChange={(e) => {
            const normalized = normaliseAmountInput(e.target.value);
            if (normalized === '' || AMOUNT_INPUT_PATTERN.test(normalized)) {
              setAmountIn(normalized);
            }
          }}
        />
      </FormControl>
      
      {loadingPool && (
        <HStack>
          <Spinner size="sm" />
          <Text fontSize="sm" color="gray.500">Loading pool state...</Text>
        </HStack>
      )}
      
      {poolState && outputAmount && (
        <Box p={3} bg="gray.50" borderRadius="md">
          <Text fontSize="sm" fontWeight="bold">Estimated Output:</Text>
          <Text fontSize="lg">{outputAmount.toString()}</Text>
          {poolState.publicReserveA > 0n && poolState.publicReserveB > 0n && (
            <Text fontSize="xs" color="gray.600" mt={1}>
              Pool: {poolState.publicReserveA.toString()} / {poolState.publicReserveB.toString()}
            </Text>
          )}
        </Box>
      )}
      
      {!poolState && tokenA && tokenB && (
        <Alert status="warning">
          <AlertIcon />
          <AlertDescription>
            Pool does not exist. Create it first via the Liquidity tab.
          </AlertDescription>
        </Alert>
      )}
      
      <Button 
        colorScheme="blue" 
        size="lg" 
        width="100%"
        onClick={handleSwap}
        isLoading={isSubmitting}
        isDisabled={!wallet.connected || !tokenA || !tokenB || !amountIn || !poolState}
      >
        {wallet.connected ? 'Swap' : 'Connect Wallet'}
      </Button>
    </VStack>
  );
}
