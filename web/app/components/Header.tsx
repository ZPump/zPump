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
          <Box
            bg="rgba(14,14,18,0.92)"
            border="1px solid rgba(255,205,96,0.25)"
            rounded="full"
            p="6px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            boxShadow="0 12px 32px rgba(12,12,16,0.45)"
          >
            <Image src="/logo.svg" alt="zPump logo" width={34} height={34} priority />
          </Box>
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
