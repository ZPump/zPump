'use client';

import { HStack, Link, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';

export function Footer() {
  return (
    <Stack as="footer" spacing={4} py={10} px={{ base: 4, md: 10 }} borderTop="1px solid rgba(255,255,255,0.05)">
      <HStack spacing={6} fontSize="sm" color="whiteAlpha.600">
        <Link as={NextLink} href="/" _hover={{ color: 'brand.200' }}>
          Home
        </Link>
        <Link as={NextLink} href="/exchange" _hover={{ color: 'brand.200' }}>
          Exchange
        </Link>
        <Link href="https://github.com" target="_blank" rel="noopener" _hover={{ color: 'brand.200' }}>
          Spec
        </Link>
      </HStack>
      <Text fontSize="xs" color="whiteAlpha.500">
        © {new Date().getFullYear()} zPump. Built so converted liquidity moves with zero-knowledge confidence.
      </Text>
    </Stack>
  );
}
