import { Metadata } from 'next';
import { UnwrapForm } from '../../components/ptf/UnwrapForm';
import { Header } from '../../components/Header';
import { Footer } from '../../components/Footer';
import { Box, Container, Stack, Text } from '@chakra-ui/react';

export const metadata: Metadata = {
  title: 'Unwrap | zPump',
  description: 'Release zNotes back into public supply or fresh zTokens with the zPump service.'
};

export default function UnwrapPage() {
  return (
    <Box minH="100vh" display="flex" flexDirection="column">
      <Header />
      <Container maxW="5xl" flex="1" py={16}>
        <Stack spacing={10}>
          <Box>
            <Text fontSize="sm" color="brand.200" textTransform="uppercase" letterSpacing="0.2em">
              Unwrap
            </Text>
            <Text fontSize="4xl" fontWeight="bold" mt={2}>
              Exit on your terms
            </Text>
            <Text mt={4} color="whiteAlpha.700" maxW="3xl">
              Supply an encrypted note reference and spending key to release your wrapped balance. The
              proof ensures nullifiers cannot be reused and keeps the vault in sync with circulating
              zTokens.
            </Text>
          </Box>
          <UnwrapForm />
        </Stack>
      </Container>
      <Footer />
    </Box>
  );
}
