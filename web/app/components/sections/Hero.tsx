'use client';

import { Box, Button, Flex, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';

export function Hero() {
  return (
    <Flex direction={{ base: 'column', md: 'row' }} align="center" py={{ base: 16, md: 24 }} px={{ base: 4, md: 10 }} gap={16}>
      <Stack spacing={8} flex={1}>
        <Heading as="h1" size="3xl" lineHeight="1.1" textShadow="0 0 30px rgba(59,205,255,0.45)">
          Privacy rails for every SPL asset.
        </Heading>
        <Text fontSize="lg" color="whiteAlpha.700" maxW="lg">
          Shield liquidity into cryptographic silence. Exit back to the public chain only when you want to be seen.
          The Privacy Twin Factory enables private balances without redeploying your mint.
        </Text>
        <HStack spacing={4}>
          <Button as={NextLink} href="/exchange" size="lg" variant="glow">
            Enter the Pool
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
          bgGradient="conic(brand.200, brand.500, brand.800, brand.200)"
          opacity={0.6}
          filter="blur(40px)"
          rounded="full"
        />
        <Box
          position="absolute"
          top="50%"
          left="50%"
          transform="translate(-50%, -50%)"
          border="1px solid rgba(59,205,255,0.25)"
          rounded="3xl"
          p={8}
          bg="rgba(6, 10, 26, 0.8)"
          minW="260px"
          textAlign="center"
          boxShadow="0 0 45px rgba(59,205,255,0.35)"
        >
          <Text fontSize="sm" color="brand.200" letterSpacing="0.12em">
            ZERO-KNOWLEDGE DRIVEN
          </Text>
          <Heading as="h2" size="lg" mt={4}>
            Shield. Transfer. Redeem.
          </Heading>
          <Text fontSize="md" color="whiteAlpha.700" mt={4}>
            Governance gated hooks keep relayers optional. Future proof from day one.
          </Text>
        </Box>
      </Flex>
    </Flex>
  );
}
