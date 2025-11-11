'use client';

import { Button, Heading, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';

export function CTA() {
  return (
    <Stack spacing={6} px={{ base: 4, md: 10 }} py={{ base: 16, md: 24 }} align="center" textAlign="center">
      <Heading size="2xl" maxW="3xl">
        Built for teams who want zk-powered conversions from day one.
      </Heading>
      <Text fontSize="lg" color="whiteAlpha.700" maxW="2xl">
        Start integrating zPump into your token lifecycle. Plug in the program IDs when they arrive and your users are
        ready to convert into zTokens from day zero.
      </Text>
      <Stack direction={{ base: 'column', sm: 'row' }} spacing={4}>
        <Button as={NextLink} href="/convert" size="lg" variant="glow">
          Launch Converter
        </Button>
        <Button as={NextLink} href="https://github.com/" size="lg" variant="outline" target="_blank" rel="noopener">
          View Documentation
        </Button>
      </Stack>
    </Stack>
  );
}
