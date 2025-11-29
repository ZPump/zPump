'use client';

import {
  Box,
  Card,
  CardBody,
  CardHeader,
  Heading,
  Text,
  VStack,
  HStack,
  Stat,
  StatLabel,
  StatNumber,
  StatHelpText,
  Button,
  useBoolean
} from '@chakra-ui/react';
import { useState, useEffect } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getDexPoolState } from '../../lib/sdk';

interface PoolCardProps {
  connection: Connection;
  tokenA: string;
  tokenB: string;
  onAddLiquidity?: () => void;
  onRemoveLiquidity?: () => void;
}

/**
 * PoolCard component displays pool statistics and user position
 */
export function PoolCard({ connection, tokenA, tokenB, onAddLiquidity, onRemoveLiquidity }: PoolCardProps) {
  const [poolState, setPoolState] = useState<any>(null);
  const [loading, setLoading] = useBoolean(false);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    if (!tokenA || !tokenB || !connection) return;
    
    const fetchPool = async () => {
      setLoading.on();
      setError(null);
      try {
        const pool = await getDexPoolState(
          connection,
          new PublicKey(tokenA),
          new PublicKey(tokenB)
        );
        setPoolState(pool);
      } catch (err: any) {
        setError(err.message);
        setPoolState(null);
      } finally {
        setLoading.off();
      }
    };
    
    void fetchPool();
    
    // Refresh every 10 seconds
    const interval = setInterval(fetchPool, 10000);
    return () => clearInterval(interval);
  }, [tokenA, tokenB, connection, setLoading]);
  
  if (!tokenA || !tokenB) {
    return (
      <Card>
        <CardBody>
          <Text color="gray.500">Select tokens to view pool info</Text>
        </CardBody>
      </Card>
    );
  }
  
  if (loading) {
    return (
      <Card>
        <CardBody>
          <Text>Loading pool state...</Text>
        </CardBody>
      </Card>
    );
  }
  
  if (error || !poolState) {
    return (
      <Card>
        <CardBody>
          <Text color="red.500">Pool does not exist</Text>
          <Text fontSize="sm" color="gray.500" mt={2}>
            Create it by adding liquidity
          </Text>
        </CardBody>
      </Card>
    );
  }
  
  // Calculate TVL (simplified - in reality would use token prices)
  const tvlTokenA = poolState.publicReserveA;
  const tvlTokenB = poolState.publicReserveB;
  
  return (
    <Card>
      <CardHeader>
        <Heading size="md">Pool Information</Heading>
      </CardHeader>
      <CardBody>
        <VStack spacing={4} align="stretch">
          <HStack spacing={4}>
            <Stat>
              <StatLabel>Reserve A</StatLabel>
              <StatNumber fontSize="lg">{tvlTokenA.toString()}</StatNumber>
            </Stat>
            <Stat>
              <StatLabel>Reserve B</StatLabel>
              <StatNumber fontSize="lg">{tvlTokenB.toString()}</StatNumber>
            </Stat>
          </HStack>
          
          <Stat>
            <StatLabel>Total LP Supply</StatLabel>
            <StatNumber fontSize="lg">{poolState.totalLpSupply.toString()}</StatNumber>
          </Stat>
          
          <Stat>
            <StatLabel>Protocol Fees (A)</StatLabel>
            <StatNumber fontSize="sm">{poolState.protocolFeeAccumulatorA.toString()}</StatNumber>
          </Stat>
          
          <Stat>
            <StatLabel>Protocol Fees (B)</StatLabel>
            <StatNumber fontSize="sm">{poolState.protocolFeeAccumulatorB.toString()}</StatNumber>
          </Stat>
          
          {(onAddLiquidity || onRemoveLiquidity) && (
            <HStack spacing={2} mt={4}>
              {onAddLiquidity && (
                <Button colorScheme="blue" size="sm" onClick={onAddLiquidity}>
                  Add Liquidity
                </Button>
              )}
              {onRemoveLiquidity && (
                <Button variant="outline" size="sm" onClick={onRemoveLiquidity}>
                  Remove Liquidity
                </Button>
              )}
            </HStack>
          )}
        </VStack>
      </CardBody>
    </Card>
  );
}
