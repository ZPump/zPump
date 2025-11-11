'use client';

import { Box, Container } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { Footer } from './Footer';
import { Header } from './Header';

interface PageContainerProps {
  children: ReactNode;
  maxW?: string | number;
}

export function PageContainer({ children, maxW = '5xl' }: PageContainerProps) {
  return (
    <Box
      minH="100vh"
      bg="radial-gradient(circle at top, rgba(59,205,255,0.12), rgba(5,5,16,0.92))"
      color="white"
      display="flex"
      flexDirection="column"
    >
      <Header />
      <Container as="main" maxW={maxW} flex="1" py={{ base: 10, md: 16 }}>
        {children}
      </Container>
      <Footer />
    </Box>
  );
}

