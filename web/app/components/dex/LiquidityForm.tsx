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
  deriveDexPoolState
} from '../../lib/sdk';
import { TokenSelector } from './TokenSelector';
import { ProofClient } from '../../lib/proofClient';
import { readStoredNotes } from '../../lib/notes/storage';
import { generateDexShieldProof } from '../../lib/dex-ztoken-helpers';

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
 * LiquidityForm component for managing zToken-only DEX liquidity
 */
export function LiquidityForm({ onTokenChange }: LiquidityFormProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { mints } = useMintCatalog();
  const proofClient = useMemo(() => new ProofClient(), []);
  
  const [tokenA, setTokenA] = useState<string>(''); // zToken mint addresses
  const [tokenB, setTokenB] = useState<string>(''); // zToken mint addresses
  
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
        setPoolState(null);
      } finally {
        setLoadingPool.off();
      }
    };
    
    void fetchPool();
  }, [originMintA, originMintB, connection, setLoadingPool]);
  
  const handleAddLiquidity = async () => {
    if (!wallet.connected || !wallet.publicKey || !tokenA || !tokenB || !amountA || !amountB || !originMintA || !originMintB) {
      setError('Please fill in all fields');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      const amountABigInt = BigInt(amountA.replace('.', ''));
      const amountBBigInt = BigInt(amountB.replace('.', ''));
      
      if (!poolState) {
        // Create pool first - requires shield proofs for initial liquidity
        // Ensure canonical order for pool state derivation
        const canonicalOrder = new PublicKey(originMintA).toBuffer().compare(new PublicKey(originMintB).toBuffer()) < 0;
        const canonicalMintA = canonicalOrder ? originMintA : originMintB;
        const canonicalMintB = canonicalOrder ? originMintB : originMintA;
        const canonicalAmountA = canonicalOrder ? amountABigInt : amountBBigInt;
        const canonicalAmountB = canonicalOrder ? amountBBigInt : amountABigInt;
        
        const poolStatePDA = deriveDexPoolState(new PublicKey(canonicalMintA), new PublicKey(canonicalMintB));
        
        const shieldProofA = await generateDexShieldProof(
          proofClient,
          connection,
          new PublicKey(canonicalMintA),
          canonicalAmountA,
          poolStatePDA
        );
        
        const shieldProofB = await generateDexShieldProof(
          proofClient,
          connection,
          new PublicKey(canonicalMintB),
          canonicalAmountB,
          poolStatePDA
        );
        
        await createDexPool({
          connection,
          wallet: wallet as any,
          tokenA: canonicalMintA,
          tokenB: canonicalMintB,
          initialAmountA: canonicalAmountA,
          initialAmountB: canonicalAmountB,
          proofClient,
          shieldProofA: {
            proof: shieldProofA.proof,
            publicInputs: shieldProofA.publicInputs,
            amountCommit: shieldProofA.amountCommit
          },
          shieldProofB: {
            proof: shieldProofB.proof,
            publicInputs: shieldProofB.publicInputs,
            amountCommit: shieldProofB.amountCommit
          }
        });
      } else {
        // Add to existing pool - requires transfer notes
        const storedNotes = readStoredNotes(wallet.publicKey.toBase58());
        const notesA = storedNotes.filter(note => 
          note.originMint === originMintA &&
          BigInt(note.amount) >= amountABigInt
        );
        const notesB = storedNotes.filter(note => 
          note.originMint === originMintB &&
          BigInt(note.amount) >= amountBBigInt
        );
        
        if (notesA.length === 0 || notesB.length === 0) {
          setError('Insufficient zToken notes. Shield tokens first.');
          setSubmitting.off();
          return;
        }
        
        const minLpTokens = 0n; // TODO: Calculate from private reserves
        
        await addDexLiquidity({
          connection,
          wallet: wallet as any,
          tokenA: originMintA,
          tokenB: originMintB,
          amountA: amountABigInt,
          amountB: amountBBigInt,
          minLpTokens,
          proofClient,
          zTokenNotesA: notesA.map(note => ({
            noteId: note.noteId,
            spendingKey: note.spendingKey,
            amount: BigInt(note.amount)
          })),
          zTokenNotesB: notesB.map(note => ({
            noteId: note.noteId,
            spendingKey: note.spendingKey,
            amount: BigInt(note.amount)
          }))
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
    if (!wallet.connected || !wallet.publicKey || !tokenA || !tokenB || !lpAmount || !poolState || !originMintA || !originMintB) {
      setError('Please fill in all fields and ensure pool exists');
      return;
    }
    
    setSubmitting.on();
    setError(null);
    
    try {
      const lpAmountBigInt = BigInt(lpAmount.replace('.', ''));
      
      // Fetch notes - pool PDA notes would be needed, but for now we'll need to implement this
      const storedNotes = readStoredNotes(wallet.publicKey.toBase58());
      // TODO: Fetch pool PDA notes for removal
      
      const minAmountA = 0n; // TODO: Calculate from private reserves
      const minAmountB = 0n; // TODO: Calculate from private reserves
      
      await removeDexLiquidity({
        connection,
        wallet: wallet as any,
        tokenA: originMintA,
        tokenB: originMintB,
        lpAmount: lpAmountBigInt,
        minAmountA,
        minAmountB,
        proofClient,
        zTokenNotesA: [], // TODO: Pool PDA notes
        zTokenNotesB: [] // TODO: Pool PDA notes
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
            Pool exists (private reserves)
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
              
              <Box p={3} bg="blue.50" borderRadius="md">
                <Text fontSize="sm" fontWeight="bold">LP Tokens:</Text>
                <Text fontSize="xs" color="gray.600">
                  LP tokens will be calculated based on private reserves (coming soon)
                </Text>
              </Box>
              
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
                  <Text fontSize="xs" color="gray.600">
                    Amounts calculated from private reserves (coming soon)
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
