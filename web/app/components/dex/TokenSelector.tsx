'use client';

import {
  Box,
  Input,
  VStack,
  Text,
  HStack,
  Image,
  useBoolean
} from '@chakra-ui/react';
import { useState, useMemo, useEffect, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useMintCatalog } from '../providers/MintCatalogProvider';
import { useConnection } from '@solana/wallet-adapter-react';
import { getTokenMetadata } from '../../lib/sdk';

interface TokenSelectorProps {
  value: string;
  onChange: (mint: string) => void;
  placeholder?: string;
  excludeMint?: string; // For preventing selecting same token in swap
}

/**
 * Simple token selector for DEX - allows selecting from mint catalog or pasting mint address
 */
export function TokenSelector({ value, onChange, placeholder = 'Select token', excludeMint }: TokenSelectorProps) {
  const { mints } = useMintCatalog();
  const { connection } = useConnection();
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useBoolean(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tokenImages, setTokenImages] = useState<Record<string, string>>({});
  
  // Find selected token info (only zTokens - mints that have zTokenMint)
  // value is the zTokenMint address
  const selectedToken = useMemo(() => {
    if (!value) return null;
    const mint = mints.find(m => m.zTokenMint === value);
    if (!mint || !mint.zTokenMint) return null;
    return {
      originMint: mint.originMint,
      zTokenMint: mint.zTokenMint,
      symbol: `z${mint.symbol}`,
      decimals: mint.decimals,
      name: mint.name || mint.symbol
    };
  }, [value, mints]);
  
  // Filter tokens by search query - only show zTokens (mints with zTokenMint)
  const filteredTokens = useMemo(() => {
    const query = searchQuery.toLowerCase();
    
    const filteredMints = mints
      .filter(m => 
        m.zTokenMint && // Only show mints that have been shielded (have zTokenMint)
        m.zTokenMint !== excludeMint &&
        m.originMint !== excludeMint &&
        (!searchQuery || 
         m.symbol.toLowerCase().includes(query) || 
         m.originMint.toLowerCase().includes(query) ||
         m.zTokenMint.toLowerCase().includes(query))
      )
      .map(m => ({
        originMint: m.originMint,
        zTokenMint: m.zTokenMint!,
        symbol: `z${m.symbol}`,
        decimals: m.decimals,
        name: m.name || m.symbol
      }))
      .slice(0, 10);
    
    return filteredMints;
  }, [searchQuery, mints, excludeMint]);
  
  // Fetch token metadata/images for visible tokens (use originMint for metadata lookup)
  useEffect(() => {
    if (!connection || !isOpen) return;
    
    const fetchImages = async () => {
      const tokensToFetch = filteredTokens.filter(m => !tokenImages[m.zTokenMint]);
      if (tokensToFetch.length === 0) return;
      
      const newImages: Record<string, string> = {};
      await Promise.all(
        tokensToFetch.map(async (mint) => {
          try {
            const mintKey = new PublicKey(mint.originMint);
            const metadata = await getTokenMetadata(connection, mintKey);
            if (metadata?.uri) {
              try {
                const response = await fetch(metadata.uri);
                if (response.ok) {
                  const metadataJson = await response.json();
                  if (metadataJson.image) {
                    // Handle IPFS URLs
                    const imageUrl = metadataJson.image.startsWith('ipfs://')
                      ? `https://ipfs.io/ipfs/${metadataJson.image.replace('ipfs://', '')}`
                      : metadataJson.image;
                    newImages[mint.zTokenMint] = imageUrl; // Use zTokenMint as key
                  }
                }
              } catch {
                // Failed to fetch metadata JSON
              }
            }
          } catch {
            // Failed to get token metadata
          }
        })
      );
      
      if (Object.keys(newImages).length > 0) {
        setTokenImages(prev => ({ ...prev, ...newImages }));
      }
    };
    
    void fetchImages();
  }, [connection, isOpen, filteredTokens, tokenImages]);
  
  // Check if pasted text is a valid mint address
  const isValidMint = useMemo(() => {
    if (!searchQuery) return false;
    try {
      new PublicKey(searchQuery);
      return true;
    } catch {
      return false;
    }
  }, [searchQuery]);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen.off();
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);
  
  const handleSelectToken = (zTokenMint: string) => {
    // zTokenMint is the zToken mint address to use in DEX operations
    onChange(zTokenMint);
    setIsOpen.off();
    setSearchQuery('');
  };
  
  const handlePasteMint = () => {
    if (isValidMint) {
      handleSelectToken(searchQuery);
    }
  };
  
  return (
    <Box position="relative" ref={containerRef} width="100%">
      {selectedToken && !isOpen ? (
        <Box
          border="1px solid"
          borderColor="gray.300"
          borderRadius="md"
          p={3}
          cursor="pointer"
          onClick={setIsOpen.on}
          bg="white"
          _hover={{ borderColor: 'brand.400', bg: 'gray.50' }}
        >
          <HStack spacing={3}>
            {tokenImages[value] && (
              <Box
                w={8}
                h={8}
                rounded="full"
                bg="gray.100"
                border="1px solid"
                borderColor="gray.200"
                overflow="hidden"
                flexShrink={0}
              >
                <img
                  src={tokenImages[value]}
                  alt={selectedToken.symbol}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </Box>
            )}
            <VStack align="start" spacing={0} flex={1}>
              <Text fontWeight="medium" color="gray.800">{selectedToken.symbol}</Text>
              <Text fontSize="xs" color="gray.500">
                {selectedToken.originMint.slice(0, 8)}...
              </Text>
            </VStack>
            <Text fontSize="sm" color="gray.500" ml="auto">
              {value.slice(0, 8)}...
            </Text>
          </HStack>
        </Box>
      ) : (
        <Input
          placeholder={placeholder}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (!isOpen) setIsOpen.on();
          }}
          onFocus={setIsOpen.on}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text/plain').trim();
            setSearchQuery(pasted);
            setIsOpen.on();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isValidMint) {
              handlePasteMint();
            } else if (e.key === 'Escape') {
              setIsOpen.off();
            }
          }}
        />
      )}
      
      {isOpen && (
        <Box
          position="absolute"
          top="100%"
          left={0}
          right={0}
          mt={1}
          bg="white"
          border="1px solid"
          borderColor="gray.200"
          borderRadius="md"
          boxShadow="lg"
          zIndex={1000}
          maxH="300px"
          overflowY="auto"
        >
          {isValidMint && searchQuery && (
            <Box
              p={2}
              cursor="pointer"
              _hover={{ bg: 'gray.100' }}
              onClick={handlePasteMint}
              borderBottom="1px solid"
              borderColor="gray.200"
            >
              <Text fontSize="sm" fontWeight="medium" color="gray.800">Use mint: {searchQuery.slice(0, 8)}...</Text>
            </Box>
          )}
          
          {filteredTokens.length > 0 ? (
            <VStack align="stretch" spacing={0}>
              {filteredTokens.map((mint) => (
                <Box
                  key={mint.originMint}
                  p={2}
                  cursor="pointer"
                  bg="white"
                  _hover={{ bg: 'gray.100' }}
                  onClick={() => handleSelectToken(mint.zTokenMint)}
                >
                  <HStack spacing={3}>
                    {tokenImages[mint.zTokenMint] ? (
                      <Box
                        w={8}
                        h={8}
                        rounded="full"
                        bg="gray.100"
                        border="1px solid"
                        borderColor="gray.200"
                        overflow="hidden"
                        flexShrink={0}
                      >
                        <img
                          src={tokenImages[mint.zTokenMint]}
                          alt={mint.symbol}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </Box>
                    ) : (
                      <Box
                        w={8}
                        h={8}
                        rounded="full"
                        bg="gray.200"
                        border="1px solid"
                        borderColor="gray.300"
                        flexShrink={0}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Text fontSize="xs" color="gray.500" fontWeight="bold">
                          {mint.symbol.slice(0, 2).toUpperCase()}
                        </Text>
                      </Box>
                    )}
                    <VStack align="start" spacing={0} flex={1}>
                      <Text fontSize="sm" fontWeight="medium" color="gray.800">{mint.symbol}</Text>
                      <Text fontSize="xs" color="gray.500">{mint.originMint.slice(0, 8)}...</Text>
                    </VStack>
                  </HStack>
                </Box>
              ))}
            </VStack>
          ) : (
            <Box p={3} textAlign="center">
              <Text fontSize="sm" color="gray.500">No tokens found</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
