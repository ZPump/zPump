'use client';

import { Box, Button, Flex, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';

export function Hero() {
  return (
    <Flex direction={{ base: 'column', md: 'row' }} align="center" py={{ base: 16, md: 24 }} px={{ base: 4, md: 10 }} gap={16}>
      <Stack spacing={8} flex={1}>
        <Heading as="h1" size="3xl" lineHeight="1.1" textShadow="0 0 30px rgba(245, 178, 27, 0.28)">
          Convert any SPL asset into zTokens.
        </Heading>
        <Text fontSize="lg" color="whiteAlpha.700" maxW="lg">
          Hand zPump your liquidity and receive zk-proof-backed balances you control. Unwrap whenever you want
          public supply again—no token redeploys, no new mint infra.
        </Text>
        <HStack spacing={4}>
          <Button as={NextLink} href="/convert" size="lg" variant="glow">
            Launch the Converter
          </Button>
          <Button as={NextLink} href="#vision" size="lg" variant="outline">
            Explore the Spec
          </Button>
        </HStack>
      </Stack>
      <Flex flex={1} justify="center" position="relative">
        <Box
          w="320px"
          h="320px"
          bgGradient="conic(brand.100, brand.400, brand.700, brand.100)"
          opacity={0.5}
          filter="blur(40px)"
          rounded="full"
        />
        <Box
          position="absolute"
          top="50%"
          left="50%"
          transform="translate(-50%, -50%)"
          border="1px solid rgba(245,178,27,0.25)"
          rounded="3xl"
          p={8}
          bg="rgba(12, 10, 6, 0.8)"
          minW="260px"
          textAlign="center"
          boxShadow="0 0 45px rgba(245, 178, 27, 0.32)"
        >
          <Text fontSize="sm" color="brand.200" letterSpacing="0.12em">
            ZERO-KNOWLEDGE DRIVEN
          </Text>
          <Heading as="h2" size="lg" mt={4}>
            Convert. Prove. Redeem.
          </Heading>
          <Text fontSize="md" color="whiteAlpha.700" mt={4}>
            Governance gated hooks keep relayers optional. Future proof from day one.
          </Text>
        </Box>
      </Flex>
    </Flex>
  );
}
