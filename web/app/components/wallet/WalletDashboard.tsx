'use client';

import { Box, Heading, Stack, Text } from '@chakra-ui/react';
import { WalletDrawerLauncher } from './WalletDrawer';

export function WalletDashboard() {
  return (
    <Stack spacing={10} align="center" textAlign="center" py={12}>
      <Stack spacing={3} maxW="3xl">
        <Heading size="2xl">Wallet</Heading>
        <Text color="whiteAlpha.700">
          Manage devnet accounts from the wallet drawer. Click the wallet icon in the header to switch accounts, copy
          addresses, or review balances.
        </Text>
      </Stack>
      <Box
        border="1px solid rgba(245,178,27,0.24)"
        bg="rgba(18, 16, 14, 0.9)"
        rounded="3xl"
        px={{ base: 6, md: 12 }}
        py={{ base: 8, md: 14 }}
        boxShadow="0 0 45px rgba(245, 178, 27, 0.22)"
      >
        <Stack spacing={6} align="center">
          <Text fontSize="lg" color="whiteAlpha.800">
            Use the header wallet icon to open the drawer.
          </Text>
          <WalletDrawerLauncher />
        </Stack>
      </Box>
    </Stack>
  );
}

