'use client';

import { Box, Flex, HStack, IconButton, Link, Text, useDisclosure } from '@chakra-ui/react';
import NextLink from 'next/link';
import Image from 'next/image';
import { MenuIcon } from 'lucide-react';
import { WalletDrawerLauncher } from './wallet/WalletDrawer';

export function Header() {
  const { isOpen, onToggle } = useDisclosure();

  return (
    <Box as="header" py={6} px={{ base: 4, md: 10 }} position="sticky" top={0} zIndex={100} backdropFilter="blur(18px)">
      <Flex align="center" justify="space-between">
        <Link as={NextLink} href="/" display="flex" alignItems="center" gap={3} _hover={{ textDecoration: 'none' }}>
          <Image src="/logo.svg" alt="zPump logo" width={36} height={36} priority />
          <Text fontSize="lg" fontWeight="semibold" letterSpacing="0.08em" color="brand.50">
            zPump
          </Text>
        </Link>
        <HStack spacing={6} display={{ base: 'none', md: 'flex' }}>
          <Link as={NextLink} href="/" _hover={{ color: 'brand.200' }}>
            Home
          </Link>
          <Link as={NextLink} href="/convert" _hover={{ color: 'brand.200' }}>
            Convert
          </Link>
          <Link as={NextLink} href="/faucet" _hover={{ color: 'brand.200' }}>
            Faucet
          </Link>
          <Link as={NextLink} href="/vault" _hover={{ color: 'brand.200' }}>
            Vaults
          </Link>
          <Link as={NextLink} href="/whitepaper" _hover={{ color: 'brand.200' }}>
            Whitepaper
          </Link>
        </HStack>
        <HStack spacing={2}>
          <WalletDrawerLauncher />
          <IconButton
            aria-label="Open navigation"
            icon={<MenuIcon size={20} />}
            variant="ghost"
            display={{ base: 'inline-flex', md: 'none' }}
            onClick={onToggle}
          />
        </HStack>
      </Flex>
      {isOpen && (
        <Flex direction="column" mt={4} gap={3} display={{ md: 'none' }}>
          <Link as={NextLink} href="/" _hover={{ color: 'brand.200' }}>
            Home
          </Link>
          <Link as={NextLink} href="/convert" _hover={{ color: 'brand.200' }}>
            Convert
          </Link>
          <Link as={NextLink} href="/faucet" _hover={{ color: 'brand.200' }}>
            Faucet
          </Link>
          <Link as={NextLink} href="/vault" _hover={{ color: 'brand.200' }}>
            Vaults
          </Link>
          <Link as={NextLink} href="/whitepaper" _hover={{ color: 'brand.200' }}>
            Whitepaper
          </Link>
        </Flex>
      )}
    </Box>
  );
}
