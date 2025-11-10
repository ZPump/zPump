import { Metadata } from 'next';
import { WrapForm } from '../../components/ptf/WrapForm';
import { Header } from '../../components/Header';
import { Footer } from '../../components/Footer';
import { Box, Container, Stack, Text } from '@chakra-ui/react';

export const metadata: Metadata = {
  title: 'Wrap | zPump',
  description: 'Wrap public SPL tokens into zk-proof-backed zTokens powered by zPump.'
};

export default function WrapPage() {
  return (
    <Box minH="100vh" display="flex" flexDirection="column">
      <Header />
      <Container maxW="5xl" flex="1" py={16}>
        <Stack spacing={10}>
          <Box>
            <Text fontSize="sm" color="brand.200" textTransform="uppercase" letterSpacing="0.2em">
              Wrap
            </Text>
            <Text fontSize="4xl" fontWeight="bold" mt={2}>
              Turn yield into wrapped confidence
            </Text>
            <Text mt={4} color="whiteAlpha.700" maxW="3xl">
              Follow the guided flow to deposit public SPL tokens into the zPump vault.
              The circuit helper will generate a Groth16 proof, enforce the wrap invariant, and hand you
              a new zNote tied to freshly minted zTokens.
            </Text>
          </Box>
          <WrapForm />
        </Stack>
      </Container>
      <Footer />
    </Box>
  );
}
