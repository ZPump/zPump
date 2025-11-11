'use client';

import { Grid, GridItem, Heading, Icon, Stack, Text } from '@chakra-ui/react';
import { LinkIcon, LockIcon, RadarIcon } from 'lucide-react';

const featureList = [
  {
    title: 'Convert with certainty',
    description:
      'zPump vault custody and zero-knowledge commitments enforce the invariant. Every conversion is provable and auditable.',
    icon: LockIcon
  },
  {
    title: 'Governance-gated hooks',
    description:
      'Relayer-ready CPI rails exist but stay dormant until governance flips the switch. Extend wrapped flows without redeploying.',
    icon: LinkIcon
  },
  {
    title: 'Frictionless UX',
    description:
      'Client-side proving, WebGPU acceleration, and a calming interface make zero-knowledge conversions feel invisible to the user.',
    icon: RadarIcon
  }
];

export function Features() {
  return (
    <Stack id="vision" spacing={16} px={{ base: 4, md: 10 }} py={{ base: 12, md: 20 }}>
      <Stack spacing={4} maxW="xl">
        <Heading size="2xl">Zero-knowledge conversions that feel native.</Heading>
        <Text fontSize="lg" color="whiteAlpha.700">
          zPump transforms any SPL mint into a wrapped zToken flow. Vaults, pools, and future relayers are already aligned.
        </Text>
      </Stack>
      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={8}>
        {featureList.map((feature) => (
          <GridItem
            key={feature.title}
            bg="rgba(10, 14, 30, 0.8)"
            border="1px solid rgba(59,205,255,0.2)"
            rounded="2xl"
            p={8}
            boxShadow="0 0 30px rgba(2, 62, 96, 0.25)"
            _hover={{ borderColor: 'brand.300', transform: 'translateY(-4px)', transition: 'all 0.3s ease' }}
          >
            <Icon as={feature.icon} boxSize={8} color="brand.300" mb={6} />
            <Heading size="md" mb={3}>
              {feature.title}
            </Heading>
            <Text color="whiteAlpha.700">{feature.description}</Text>
          </GridItem>
        ))}
      </Grid>
    </Stack>
  );
}
