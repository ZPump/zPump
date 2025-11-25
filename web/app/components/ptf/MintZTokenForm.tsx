'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  Input,
  NumberInput,
  NumberInputField,
  Stack,
  Text,
  Textarea,
  useBoolean,
  useToast
} from '@chakra-ui/react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useState } from 'react';
import { mintNativeZToken } from '../../lib/sdk';
import { uploadImage, uploadMetadata, createTokenMetadata, getIPFSURL } from '../../lib/ipfs';
import { normalizeError } from '../../lib/errorHandler';

export function MintZTokenForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [decimals, setDecimals] = useState(6);
  const [initialSupply, setInitialSupply] = useState('');
  const [feeBpsOverride, setFeeBpsOverride] = useState('');
  const [isSubmitting, setIsSubmitting] = useBoolean(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ signature: string; mint: string } | null>(null);

  const handleImageChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: 'Image too large',
          description: 'Maximum image size is 5MB',
          status: 'error'
        });
        return;
      }
      setImageFile(file);
    }
  }, [toast]);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!wallet.connected || !wallet.publicKey) {
      setError('Please connect your wallet');
      return;
    }

    // Validate inputs
    if (!name.trim() || name.length > 32) {
      setError('Token name must be 1-32 characters');
      return;
    }
    if (!symbol.trim() || symbol.length > 10) {
      setError('Token symbol must be 1-10 characters');
      return;
    }
    if (decimals < 0 || decimals > 9) {
      setError('Decimals must be 0-9');
      return;
    }
    if (!initialSupply || Number(initialSupply) <= 0) {
      setError('Initial supply must be greater than 0');
      return;
    }

    setIsSubmitting.on();

    try {
      // Upload image to IPFS if provided
      let imageCid: string | undefined;
      if (imageFile) {
        imageCid = await uploadImage(imageFile);
      }

      // Create and upload metadata
      const metadata = createTokenMetadata({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim() || undefined,
        imageCid,
      });
      const metadataCid = await uploadMetadata(metadata);
      const uri = `ipfs://${metadataCid}`;

      // Parse initial supply
      const supplyValue = BigInt(Math.floor(Number(initialSupply) * 10 ** decimals));

      // Parse fee override if provided
      const feeOverride = feeBpsOverride ? Number(feeBpsOverride) : undefined;
      if (feeOverride !== undefined && (feeOverride < 0 || feeOverride > 1000)) {
        throw new Error('Fee override must be 0-1000 basis points (0-10%)');
      }

      // Mint the token
      const signature = await mintNativeZToken({
        connection,
        wallet,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        uri,
        decimals,
        initialSupply: supplyValue,
        feeBpsOverride: feeOverride,
      });

      // Extract mint address from transaction (would need to parse transaction logs)
      // For now, we'll show the signature
      setSuccess({ signature, mint: 'Check transaction logs for mint address' });

      toast({
        title: 'Token minted successfully',
        description: `Transaction: ${signature}`,
        status: 'success',
        duration: 5000,
        isClosable: true
      });
    } catch (err) {
      const errorMessage = normalizeError(err);
      setError(errorMessage);
      toast({
        title: 'Minting failed',
        description: errorMessage,
        status: 'error',
        duration: 5000,
        isClosable: true
      });
    } finally {
      setIsSubmitting.off();
    }
  }, [
    wallet,
    connection,
    name,
    symbol,
    description,
    imageFile,
    decimals,
    initialSupply,
    feeBpsOverride,
    setIsSubmitting,
    toast
  ]);

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      bg="rgba(18, 16, 14, 0.88)"
      p={{ base: 6, md: 10 }}
      rounded="3xl"
      border="1px solid rgba(245,178,27,0.24)"
      boxShadow="0 0 45px rgba(245, 178, 27, 0.22)"
      maxW="2xl"
      mx="auto"
    >
      <Stack spacing={6}>
        <Heading size="lg">Mint Native zToken</Heading>
        <Text color="gray.400">
          Create a new zToken with metadata stored on IPFS. The initial supply will be minted to your wallet as traditional tokens, which you can then shield.
        </Text>

        {error && (
          <Alert status="error">
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert status="success">
            <AlertIcon />
            <AlertDescription>
              Token minted! Transaction: {success.signature}
            </AlertDescription>
          </Alert>
        )}

        <FormControl isRequired>
          <FormLabel>Token Name</FormLabel>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Token"
            maxLength={32}
          />
          <FormHelperText>1-32 characters</FormHelperText>
        </FormControl>

        <FormControl isRequired>
          <FormLabel>Token Symbol</FormLabel>
          <Input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="MTK"
            maxLength={10}
          />
          <FormHelperText>1-10 characters, will be uppercased</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Description</FormLabel>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Token description (optional, stored on IPFS)"
            rows={3}
          />
        </FormControl>

        <FormControl>
          <FormLabel>Token Image</FormLabel>
          <Input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleImageChange}
          />
          <FormHelperText>Optional, max 5MB (PNG, JPG, or WebP)</FormHelperText>
          {imageFile && (
            <Text fontSize="sm" color="gray.400" mt={2}>
              Selected: {imageFile.name} ({(imageFile.size / 1024).toFixed(2)} KB)
            </Text>
          )}
        </FormControl>

        <FormControl isRequired>
          <FormLabel>Decimals</FormLabel>
          <NumberInput
            value={decimals}
            onChange={(_, val) => setDecimals(isNaN(val) ? 6 : val)}
            min={0}
            max={9}
          >
            <NumberInputField />
          </NumberInput>
          <FormHelperText>0-9 (default: 6)</FormHelperText>
        </FormControl>

        <FormControl isRequired>
          <FormLabel>Initial Supply</FormLabel>
          <NumberInput
            value={initialSupply}
            onChange={(_, val) => setInitialSupply(isNaN(val) ? '' : val.toString())}
            min={0}
            precision={decimals}
          >
            <NumberInputField placeholder="1000000" />
          </NumberInput>
          <FormHelperText>Amount to mint (will be minted as traditional tokens to your wallet)</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Fee Override (basis points)</FormLabel>
          <NumberInput
            value={feeBpsOverride}
            onChange={(_, val) => setFeeBpsOverride(isNaN(val) ? '' : val.toString())}
            min={0}
            max={1000}
          >
            <NumberInputField placeholder="Optional (0-1000 = 0-10%)" />
          </NumberInput>
          <FormHelperText>Optional custom fee (0-1000 basis points = 0-10%)</FormHelperText>
        </FormControl>

        <Button
          type="submit"
          colorScheme="yellow"
          size="lg"
          isLoading={isSubmitting}
          loadingText="Minting..."
          isDisabled={!wallet.connected}
        >
          {wallet.connected ? 'Mint zToken' : 'Connect Wallet'}
        </Button>
      </Stack>
    </Box>
  );
}

