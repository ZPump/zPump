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
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { getTokenMetadata } from '../../lib/sdk';
import { NATIVE_SOL_MINT, getWrappedSolBalance } from '../../lib/solWrapping';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

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
  const wallet = useWallet();
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useBoolean(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tokenImages, setTokenImages] = useState<Record<string, string>>({});
  const [solBalance, setSolBalance] = useState<number>(0);
  const [wsolBalance, setWsolBalance] = useState<bigint>(0n);
  
  // Fetch SOL and wSOL balances
  useEffect(() => {
    if (!connection || !wallet.publicKey) {
      setSolBalance(0);
      setWsolBalance(0n);
      return;
    }
    
    const fetchBalances = async () => {
      try {
        const [lamports, wsolLamports] = await Promise.all([
          connection.getBalance(wallet.publicKey!),
          getWrappedSolBalance(connection, wallet.publicKey!)
        ]);
        setSolBalance(lamports / LAMPORTS_PER_SOL);
        setWsolBalance(wsolLamports);
      } catch (error) {
        console.warn('[TokenSelector] Failed to fetch SOL balances:', error);
      }
    };
    
    void fetchBalances();
  }, [connection, wallet.publicKey]);
  
  // Find selected token info
  const selectedToken = useMemo(() => {
    if (!value) return null;
    if (value === NATIVE_SOL_MINT.toBase58()) {
      return { originMint: NATIVE_SOL_MINT.toBase58(), symbol: 'SOL', decimals: 9 };
    }
    return mints.find(m => m.originMint === value);
  }, [value, mints]);
  
  // Filter tokens by search query, including SOL option
  const filteredTokens = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const solOption = {
      originMint: NATIVE_SOL_MINT.toBase58(),
      symbol: 'SOL',
      decimals: 9,
      name: 'Solana'
    };
    
    // Always include SOL if it matches query or no query
    const includeSOL = !searchQuery || 'sol'.includes(query);
    const solIncluded = includeSOL && solOption.originMint !== excludeMint;
    
    const filteredMints = mints
      .filter(m => 
        m.originMint !== excludeMint &&
        m.originMint !== NATIVE_SOL_MINT.toBase58() && // Don't show wSOL separately
        (!searchQuery || 
         m.symbol.toLowerCase().includes(query) || 
         m.originMint.toLowerCase().includes(query))
      )
      .slice(0, solIncluded ? 9 : 10); // Reserve one slot for SOL if including it
    
    return solIncluded ? [solOption, ...filteredMints] : filteredMints;
  }, [searchQuery, mints, excludeMint]);
  
  // Fetch token metadata/images for visible tokens
  useEffect(() => {
    if (!connection || !isOpen) return;
    
    const fetchImages = async () => {
      const tokensToFetch = filteredTokens.filter(m => !tokenImages[m.originMint]);
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
                    newImages[mint.originMint] = imageUrl;
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
  
  const handleSelectToken = (mint: string) => {
    onChange(mint);
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
            {tokenImages[selectedToken.originMint] && (
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
                  src={tokenImages[selectedToken.originMint]}
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
              {selectedToken.originMint === NATIVE_SOL_MINT.toBase58() && (
                <Text fontSize="xs" color="gray.500">
                  {(solBalance + Number(wsolBalance) / LAMPORTS_PER_SOL).toFixed(4)} available
                </Text>
              )}
            </VStack>
            {selectedToken.originMint !== NATIVE_SOL_MINT.toBase58() && (
              <Text fontSize="sm" color="gray.500" ml="auto">
                {selectedToken.originMint.slice(0, 8)}...
              </Text>
            )}
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
                  onClick={() => handleSelectToken(mint.originMint)}
                >
                  <HStack spacing={3}>
                    {tokenImages[mint.originMint] ? (
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
                          src={tokenImages[mint.originMint]}
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
                      {mint.originMint === NATIVE_SOL_MINT.toBase58() ? (
                        <Text fontSize="xs" color="gray.500">
                          {(solBalance + Number(wsolBalance) / LAMPORTS_PER_SOL).toFixed(4)} available
                        </Text>
                      ) : (
                        <Text fontSize="xs" color="gray.500">{mint.originMint.slice(0, 8)}...</Text>
                      )}
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
