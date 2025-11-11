'use client';

import { Box, Flex, HStack, IconButton, Link, Text, useDisclosure } from '@chakra-ui/react';
import NextLink from 'next/link';
import { Layers, MenuIcon } from 'lucide-react';
import { WalletDrawerLauncher } from './wallet/WalletDrawer';

export function Header() {
  const { isOpen, onToggle } = useDisclosure();

  return (
    <Box as="header" py={6} px={{ base: 4, md: 10 }} position="sticky" top={0} zIndex={100} backdropFilter="blur(18px)">
      <Flex align="center" justify="space-between">
        <HStack spacing={3}>
          <Box
            bgGradient="linear(to-r, brand.400, brand.600)"
            rounded="full"
            p={2}
            display="flex"
            alignItems="center"
            justifyContent="center"
            boxShadow="0 0 20px rgba(59,205,255,0.5)"
          >
            <Layers size={20} color="#050510" />
          </Box>
          <Text fontSize="lg" fontWeight="semibold" letterSpacing="0.08em">
            ZPUMP
          </Text>
        </HStack>
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
