'use client';

import { HStack, Icon, Link, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { Github, Twitter } from 'lucide-react';

export function Footer() {
  return (
    <Stack as="footer" spacing={4} py={10} px={{ base: 4, md: 10 }} borderTop="1px solid rgba(255,255,255,0.05)">
      <HStack spacing={6} fontSize="sm" color="whiteAlpha.600">
        <Link href="https://github.com/ZPump/zPump" target="_blank" rel="noopener" _hover={{ color: 'brand.200' }}>
          <HStack spacing={2}>
            <Icon as={Github} boxSize={4} />
            <Text as="span">GitHub</Text>
          </HStack>
        </Link>
        <Link href="https://x.com/_zPump_" target="_blank" rel="noopener" _hover={{ color: 'brand.200' }}>
          <HStack spacing={2}>
            <Icon as={Twitter} boxSize={4} />
            <Text as="span">Twitter</Text>
          </HStack>
        </Link>
      </HStack>
      <Text fontSize="xs" color="whiteAlpha.500">
        © {new Date().getFullYear()} zPump. Built so converted liquidity moves with zero-knowledge confidence.
      </Text>
    </Stack>
  );
}
