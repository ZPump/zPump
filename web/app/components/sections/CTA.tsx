'use client';

import { Button, Heading, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';

export function CTA() {
  return (
    <Stack spacing={6} px={{ base: 4, md: 10 }} py={{ base: 16, md: 24 }} align="center" textAlign="center">
      <Heading size="2xl" maxW="3xl">
        Built for builders who expect privacy to be a primitive.
      </Heading>
      <Text fontSize="lg" color="whiteAlpha.700" maxW="2xl">
        Start integrating the Privacy Twin Factory into your token lifecycle. Plug in the program IDs when they arrive and
        your users are ready to shield from day zero.
      </Text>
      <Stack direction={{ base: 'column', sm: 'row' }} spacing={4}>
        <Button as={NextLink} href="/exchange" size="lg" variant="glow">
          Launch Exchange
        </Button>
        <Button as={NextLink} href="https://github.com/" size="lg" variant="outline" target="_blank" rel="noopener">
          View Documentation
        </Button>
      </Stack>
    </Stack>
  );
}
