import { Metadata } from 'next';
import { ShieldForm } from '../../components/ptf/ShieldForm';
import { Header } from '../../components/Header';
import { Footer } from '../../components/Footer';
import { Box, Container, Stack, Text } from '@chakra-ui/react';

export const metadata: Metadata = {
  title: 'Shield | Privacy Twin Factory',
  description: 'Convert public SPL tokens into private notes backed by the Privacy Twin Factory.'
};

export default function ShieldPage() {
  return (
    <Box minH="100vh" display="flex" flexDirection="column">
      <Header />
      <Container maxW="5xl" flex="1" py={16}>
        <Stack spacing={10}>
          <Box>
            <Text fontSize="sm" color="brand.200" textTransform="uppercase" letterSpacing="0.2em">
              Shield
            </Text>
            <Text fontSize="4xl" fontWeight="bold" mt={2}>
              Move into the privacy pool
            </Text>
            <Text mt={4} color="whiteAlpha.700" maxW="3xl">
              Follow the guided flow to deposit public SPL tokens into the programme-controlled vault.
              The circuit helper will generate a Groth16 proof, enforce the supply invariant, and mint a
              new private note for your wallet.
            </Text>
          </Box>
          <ShieldForm />
        </Stack>
      </Container>
      <Footer />
    </Box>
  );
}
