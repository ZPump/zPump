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
  getDexPoolState
} from '../../lib/sdk';
import { ProofClient } from '../../lib/proofClient';
import { readStoredNotes } from '../../lib/notes/storage';
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
 * SwapForm component for zToken-only DEX swaps
 * Only supports zToken → zToken swaps
 */
export function SwapForm({ onTokenChange }: SwapFormProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { mints } = useMintCatalog();
  
  const [tokenA, setTokenA] = useState<string>(''); // zToken mint addresses
  const [tokenB, setTokenB] = useState<string>(''); // zToken mint addresses
  const proofClient = useMemo(() => new ProofClient(), []);
  
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
  
  // Get origin mints from zToken mints (for pool lookup)
  const originMintA = useMemo(() => {
    if (!tokenA) return null;
    const mint = mints.find(m => m.zTokenMint === tokenA);
    return mint?.originMint || null;
  }, [tokenA, mints]);
  
  const originMintB = useMemo(() => {
    if (!tokenB) return null;
    const mint = mints.find(m => m.zTokenMint === tokenB);
    return mint?.originMint || null;
  }, [tokenB, mints]);
  
  // Calculate swap direction (based on origin mints)
  const aToB = useMemo(() => {
    if (!originMintA || !originMintB) return true;
    try {
      const aKey = new PublicKey(originMintA);
      const bKey = new PublicKey(originMintB);
      return aKey.toBuffer().compare(bKey.toBuffer()) < 0;
    } catch {
      return true;
    }
  }, [originMintA, originMintB]);
  
  // Fetch pool state when tokens change
  useEffect(() => {
    if (!originMintA || !originMintB || !connection) {
      setPoolState(null);
      return;
    }
    
    const fetchPool = async () => {
      setLoadingPool.on();
      setError(null);
      try {
        const pool = await getDexPoolState(
          connection,
          new PublicKey(originMintA),
          new PublicKey(originMintB)
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
  }, [originMintA, originMintB, connection, setLoadingPool]);
  
  const handleSwap = async () => {
    if (!wallet.connected || !wallet.publicKey || !tokenA || !tokenB || !amountIn || !poolState || !originMintA) {
      setError('Please fill in all fields and ensure pool exists');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      // Fetch user's zToken notes for the input token
      const storedNotes = readStoredNotes(wallet.publicKey.toBase58());
      const inputNotes = storedNotes.filter(note => 
        note.originMint === originMintA &&
        BigInt(note.amount) >= BigInt(amountIn.replace('.', ''))
      );
      
      if (inputNotes.length === 0) {
        setError('No zToken notes found for the input amount. Shield tokens first.');
        setSubmitting.off();
        return;
      }
      
      const amountInBigInt = BigInt(amountIn.replace('.', ''));
      const minAmountOut = 0n; // TODO: Calculate from private reserves (requires commitment decryption)
      
      const signature = await swapDex({
        connection,
        wallet: wallet as any,
        tokenA: originMintA, // SDK expects origin mints
        tokenB: originMintB!,
        amountIn: amountInBigInt,
        minAmountOut,
        aToB,
        proofClient,
        zTokenInputNotes: inputNotes.map(note => ({
          noteId: note.noteId,
          spendingKey: note.spendingKey,
          amount: BigInt(note.amount)
        }))
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
      
      {poolState && (
        <Box p={3} bg="gray.50" borderRadius="md">
          <Text fontSize="sm" fontWeight="bold">Pool Status:</Text>
          <Text fontSize="xs" color="gray.600" mt={1}>
            Pool exists (private reserves)
          </Text>
          <Text fontSize="xs" color="gray.500" mt={1}>
            Note: Swap output calculation requires private reserve commitments (coming soon)
          </Text>
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
