'use client';

import {
  Box,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Heading,
  VStack,
  Grid,
  GridItem,
  Text
} from '@chakra-ui/react';
import { useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { SwapForm } from './SwapForm';
import { LiquidityForm } from './LiquidityForm';
import { PoolCard } from './PoolCard';

export function DexPage() {
  const { connection } = useConnection();
  const [selectedTokenA, setSelectedTokenA] = useState<string>('');
  const [selectedTokenB, setSelectedTokenB] = useState<string>('');
  const [showPoolCard, setShowPoolCard] = useState(false);
  
  // Track token selections from forms to show pool card
  const handleTokenChange = (tokenA: string, tokenB: string) => {
    setSelectedTokenA(tokenA);
    setSelectedTokenB(tokenB);
    setShowPoolCard(!!tokenA && !!tokenB);
  };
  
  return (
    <VStack spacing={6} align="stretch" py={8}>
      <VStack spacing={2}>
        <Heading as="h1" size="xl" textAlign="center">
          DEX
        </Heading>
        <Text color="gray.500" textAlign="center">
          Universal, permissionless decentralized exchange
        </Text>
      </VStack>
      
      <Tabs colorScheme="blue" variant="line" isLazy>
        <TabList justifyContent="center">
          <Tab>Swap</Tab>
          <Tab>Liquidity</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <Grid templateColumns={{ base: '1fr', lg: '1fr 400px' }} gap={6}>
              <GridItem>
                <Box maxW="500px" mx={{ base: 'auto', lg: 0 }} w="100%">
                  <SwapForm onTokenChange={handleTokenChange} />
                </Box>
              </GridItem>
              {showPoolCard && (
                <GridItem>
                  <PoolCard
                    connection={connection}
                    tokenA={selectedTokenA}
                    tokenB={selectedTokenB}
                  />
                </GridItem>
              )}
            </Grid>
          </TabPanel>
          
          <TabPanel>
            <Grid templateColumns={{ base: '1fr', lg: '1fr 400px' }} gap={6}>
              <GridItem>
                <Box maxW="600px" mx={{ base: 'auto', lg: 0 }} w="100%">
                  <LiquidityForm onTokenChange={handleTokenChange} />
                </Box>
              </GridItem>
              {showPoolCard && (
                <GridItem>
                  <PoolCard
                    connection={connection}
                    tokenA={selectedTokenA}
                    tokenB={selectedTokenB}
                    onAddLiquidity={() => {/* TODO: Scroll to add liquidity form */}}
                    onRemoveLiquidity={() => {/* TODO: Scroll to remove liquidity form */}}
                  />
                </GridItem>
              )}
            </Grid>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </VStack>
  );
}
