import { Metadata } from 'next';
import { Box, Heading, Stack, Text } from '@chakra-ui/react';
import { Header } from '../../components/Header';
import { Footer } from '../../components/Footer';
import { ExchangeForm } from '../../components/exchange/ExchangeForm';

export const metadata: Metadata = {
  title: 'Exchange | zPump'
};

export default function ExchangePage() {
  return (
    <main>
      <Header />
      <Stack spacing={12} px={{ base: 4, md: 10 }} py={{ base: 12, md: 20 }}>
        <Stack spacing={3} maxW="2xl">
          <Heading size="3xl">Preview the zPump wrapping flow.</Heading>
          <Text fontSize="lg" color="whiteAlpha.700">
            Simulate how wrapping and unwrapping will feel when the on-chain programs go live. Plug in program IDs later
            without touching the interface.
          </Text>
        </Stack>
        <Box maxW="xl">
          <ExchangeForm />
        </Box>
      </Stack>
      <Footer />
    </main>
  );
}
