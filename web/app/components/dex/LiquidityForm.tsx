'use client';

import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Heading,
  Input,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  VStack,
  Alert,
  AlertIcon,
  AlertDescription,
  useBoolean,
  HStack,
  Spinner
} from '@chakra-ui/react';
import { useState, useEffect, useMemo } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { 
  createDexPool,
  addDexLiquidity,
  removeDexLiquidity,
  getDexPoolState,
  calculateLPTokens
} from '../../lib/sdk';
import { TokenSelector } from './TokenSelector';

const AMOUNT_INPUT_PATTERN = /^\d*(?:\.\d*)?$/;

function normaliseAmountInput(value: string): string {
  let trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('.')) trimmed = `0${trimmed}`;
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

interface LiquidityFormProps {
  onTokenChange?: (tokenA: string, tokenB: string) => void;
}

/**
 * LiquidityForm component for managing DEX liquidity
 * Handles adding and removing liquidity for all pair types
 */
export function LiquidityForm({ onTokenChange }: LiquidityFormProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  
  const [tokenA, setTokenA] = useState<string>('');
  const [tokenB, setTokenB] = useState<string>('');
  
  // Notify parent of token changes
  useEffect(() => {
    if (onTokenChange) {
      onTokenChange(tokenA, tokenB);
    }
  }, [tokenA, tokenB, onTokenChange]);
  const [amountA, setAmountA] = useState<string>('');
  const [amountB, setAmountB] = useState<string>('');
  const [lpAmount, setLpAmount] = useState<string>('');
  const [isSubmitting, setSubmitting] = useBoolean(false);
  const [error, setError] = useState<string | null>(null);
  const [poolState, setPoolState] = useState<any>(null);
  const [loadingPool, setLoadingPool] = useBoolean(false);
  
  // Fetch pool state when tokens change
  useEffect(() => {
    if (!tokenA || !tokenB || !connection) {
      setPoolState(null);
      return;
    }
    
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
        setPoolState(null);
      } finally {
        setLoadingPool.off();
      }
    };
    
    void fetchPool();
  }, [tokenA, tokenB, connection, setLoadingPool]);
  
  // Calculate expected LP tokens for adding liquidity
  const expectedLpTokens = useMemo(() => {
    if (!amountA || !amountB || !poolState) return null;
    
    try {
      const amountABigInt = BigInt(amountA.replace('.', ''));
      const amountBBigInt = BigInt(amountB.replace('.', ''));
      
      if (poolState.totalLpSupply === 0n) {
        // Initial liquidity
        const product = amountABigInt * amountBBigInt;
        const sqrt = BigInt(Math.sqrt(Number(product)));
        return sqrt > 1000n ? sqrt - 1000n : 0n;
      } else {
        return calculateLPTokens(
          amountABigInt,
          amountBBigInt,
          poolState.publicReserveA,
          poolState.publicReserveB,
          poolState.totalLpSupply
        );
      }
    } catch {
      return null;
    }
  }, [amountA, amountB, poolState]);
  
  const handleAddLiquidity = async () => {
    if (!wallet.connected || !tokenA || !tokenB || !amountA || !amountB) {
      setError('Please fill in all fields');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      const amountABigInt = BigInt(amountA.replace('.', ''));
      const amountBBigInt = BigInt(amountB.replace('.', ''));
      const minLpTokens = expectedLpTokens ? (expectedLpTokens * 95n) / 100n : 0n;
      
      if (!poolState) {
        // Create pool first
        await createDexPool({
          connection,
          wallet: wallet as any,
          tokenA,
          tokenB,
          initialAmountA: amountABigInt,
          initialAmountB: amountBBigInt,
          tokenAIsZtoken: false, // TODO: detect zToken
          tokenBIsZtoken: false
        });
      } else {
        // Add to existing pool
        await addDexLiquidity({
          connection,
          wallet: wallet as any,
          tokenA,
          tokenB,
          amountA: amountABigInt,
          amountB: amountBBigInt,
          minLpTokens
        });
      }
      
      setError(null);
      // TODO: Show success toast
      console.log('Liquidity added successfully');
    } catch (err: any) {
      setError(err.message || 'Failed to add liquidity');
    } finally {
      setSubmitting.off();
    }
  };
  
  const handleRemoveLiquidity = async () => {
    if (!wallet.connected || !tokenA || !tokenB || !lpAmount || !poolState) {
      setError('Please fill in all fields and ensure pool exists');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      const lpAmountBigInt = BigInt(lpAmount.replace('.', ''));
      const expectedAmountA = (lpAmountBigInt * poolState.publicReserveA) / poolState.totalLpSupply;
      const expectedAmountB = (lpAmountBigInt * poolState.publicReserveB) / poolState.totalLpSupply;
      const minAmountA = (expectedAmountA * 95n) / 100n;
      const minAmountB = (expectedAmountB * 95n) / 100n;
      
      await removeDexLiquidity({
        connection,
        wallet: wallet as any,
        tokenA,
        tokenB,
        lpAmount: lpAmountBigInt,
        minAmountA,
        minAmountB
      });
      
      setError(null);
      console.log('Liquidity removed successfully');
    } catch (err: any) {
      setError(err.message || 'Failed to remove liquidity');
    } finally {
      setSubmitting.off();
    }
  };
  
  return (
    <VStack spacing={4} align="stretch">
      <Heading size="md">Manage Liquidity</Heading>
      
      {error && (
        <Alert status="error">
          <AlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      
      <FormControl>
        <FormLabel>Token A</FormLabel>
        <TokenSelector
          value={tokenA}
          onChange={setTokenA}
          placeholder="Select or paste token A mint"
          excludeMint={tokenB}
        />
      </FormControl>
      
      <FormControl>
        <FormLabel>Token B</FormLabel>
        <TokenSelector
          value={tokenB}
          onChange={setTokenB}
          placeholder="Select or paste token B mint"
          excludeMint={tokenA}
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
          <Text fontSize="sm" fontWeight="bold">Pool Info:</Text>
          <Text fontSize="xs" color="gray.600">
            Reserves: {poolState.publicReserveA.toString()} / {poolState.publicReserveB.toString()}
          </Text>
          <Text fontSize="xs" color="gray.600">
            Total LP Supply: {poolState.totalLpSupply.toString()}
          </Text>
        </Box>
      )}
      
      <Tabs colorScheme="blue" variant="line">
        <TabList>
          <Tab>Add</Tab>
          <Tab>Remove</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <VStack spacing={4} align="stretch" pt={4}>
              <FormControl>
                <FormLabel>Amount A</FormLabel>
                <Input
                  type="text"
                  placeholder="0.0"
                  value={amountA}
                  onChange={(e) => {
                    const normalized = normaliseAmountInput(e.target.value);
                    if (normalized === '' || AMOUNT_INPUT_PATTERN.test(normalized)) {
                      setAmountA(normalized);
                    }
                  }}
                />
              </FormControl>
              
              <FormControl>
                <FormLabel>Amount B</FormLabel>
                <Input
                  type="text"
                  placeholder="0.0"
                  value={amountB}
                  onChange={(e) => {
                    const normalized = normaliseAmountInput(e.target.value);
                    if (normalized === '' || AMOUNT_INPUT_PATTERN.test(normalized)) {
                      setAmountB(normalized);
                    }
                  }}
                />
              </FormControl>
              
              {expectedLpTokens && (
                <Box p={3} bg="blue.50" borderRadius="md">
                  <Text fontSize="sm" fontWeight="bold">Expected LP Tokens:</Text>
                  <Text fontSize="lg">{expectedLpTokens.toString()}</Text>
                </Box>
              )}
              
              <Button 
                colorScheme="blue" 
                size="lg" 
                width="100%"
                onClick={handleAddLiquidity}
                isLoading={isSubmitting}
                isDisabled={!wallet.connected || !tokenA || !tokenB || !amountA || !amountB}
              >
                {poolState ? 'Add Liquidity' : 'Create Pool & Add Liquidity'}
              </Button>
            </VStack>
          </TabPanel>
          
          <TabPanel>
            <VStack spacing={4} align="stretch" pt={4}>
              {!poolState && (
                <Alert status="warning">
                  <AlertIcon />
                  <AlertDescription>Pool does not exist. Create it first via Add tab.</AlertDescription>
                </Alert>
              )}
              
              <FormControl>
                <FormLabel>LP Token Amount</FormLabel>
                <Input
                  type="text"
                  placeholder="0.0"
                  value={lpAmount}
                  onChange={(e) => {
                    const normalized = normaliseAmountInput(e.target.value);
                    if (normalized === '' || AMOUNT_INPUT_PATTERN.test(normalized)) {
                      setLpAmount(normalized);
                    }
                  }}
                />
              </FormControl>
              
              {lpAmount && poolState && (
                <Box p={3} bg="blue.50" borderRadius="md">
                  <Text fontSize="sm" fontWeight="bold">You will receive:</Text>
                  <Text fontSize="sm">
                    Token A: {((BigInt(lpAmount.replace('.', '')) * poolState.publicReserveA) / poolState.totalLpSupply).toString()}
                  </Text>
                  <Text fontSize="sm">
                    Token B: {((BigInt(lpAmount.replace('.', '')) * poolState.publicReserveB) / poolState.totalLpSupply).toString()}
                  </Text>
                </Box>
              )}
              
              <Button 
                colorScheme="red" 
                size="lg" 
                width="100%"
                onClick={handleRemoveLiquidity}
                isLoading={isSubmitting}
                isDisabled={!wallet.connected || !tokenA || !tokenB || !lpAmount || !poolState}
              >
                Remove Liquidity
              </Button>
            </VStack>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </VStack>
  );
}
