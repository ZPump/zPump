import { Metadata } from 'next';
import { UnshieldForm } from '../../components/ptf/UnshieldForm';
import { Header } from '../../components/Header';
import { Footer } from '../../components/Footer';
import { Box, Container, Stack, Text } from '@chakra-ui/react';

export const metadata: Metadata = {
  title: 'Unshield | Privacy Twin Factory',
  description: 'Exit the shielded pool into public origin or twin tokens.'
};

export default function UnshieldPage() {
  return (
    <Box minH="100vh" display="flex" flexDirection="column">
      <Header />
      <Container maxW="5xl" flex="1" py={16}>
        <Stack spacing={10}>
          <Box>
            <Text fontSize="sm" color="brand.200" textTransform="uppercase" letterSpacing="0.2em">
              Unshield
            </Text>
            <Text fontSize="4xl" fontWeight="bold" mt={2}>
              Exit to a public account
            </Text>
            <Text mt={4} color="whiteAlpha.700" maxW="3xl">
              Supply an encrypted note reference and spending key to unlock your private balance. The
              proof ensures nullifiers cannot be reused and verifies that the Vault balance stays in
              sync with privacy twin supply.
            </Text>
          </Box>
          <UnshieldForm />
        </Stack>
      </Container>
      <Footer />
    </Box>
  );
}
