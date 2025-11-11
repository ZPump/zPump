'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Collapse,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  NumberInput,
  NumberInputField,
  Select,
  Stack,
  Switch,
  Text,
  useBoolean
} from '@chakra-ui/react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useMemo, useState } from 'react';
import { MINTS, MintConfig } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import { wrap as wrapSdk, unwrap as unwrapSdk, resolvePublicKey } from '../../lib/sdk';

type ConvertMode = 'to-private' | 'to-public';

interface WrapAdvancedState {
  depositId: string;
  blinding: string;
  useProofRpc: boolean;
}

interface UnwrapAdvancedState {
  destination: string;
  exitFee: string;
  noteId: string;
  spendingKey: string;
  useProofRpc: boolean;
}

const createRandomSeed = () => Math.floor(Math.random() * 1_000_000).toString();

export function ConvertForm() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [mode, setMode] = useState<ConvertMode>('to-private');
  const [originMint, setOriginMint] = useState<string>(MINTS[0]?.originMint ?? '');
  const [amount, setAmount] = useState<string>('1');
  const [isSubmitting, setSubmitting] = useBoolean(false);
  const [showAdvanced, setShowAdvanced] = useBoolean(false);

  const [wrapAdvanced, setWrapAdvanced] = useState<WrapAdvancedState>({
    depositId: createRandomSeed(),
    blinding: createRandomSeed(),
    useProofRpc: true
  });

  const [unwrapAdvanced, setUnwrapAdvanced] = useState<UnwrapAdvancedState>({
    destination: '',
    exitFee: '0',
    noteId: createRandomSeed(),
    spendingKey: createRandomSeed(),
    useProofRpc: true
  });

  const [result, setResult] = useState<string | null>(null);
  const [proofPreview, setProofPreview] = useState<ProofResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mintConfig = useMemo<MintConfig | undefined>(
    () => MINTS.find((mint) => mint.originMint === originMint),
    [originMint]
  );

  const zTokenSymbol = useMemo(() => `z${mintConfig?.symbol ?? 'TOKEN'}`, [mintConfig?.symbol]);

  const proofClient = useMemo(() => new ProofClient(), []);

  const handleModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setMode(event.target.value as ConvertMode);
    setResult(null);
    setProofPreview(null);
    setError(null);
  };

  const handleWrapAdvancedChange =
    (field: keyof WrapAdvancedState) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.type === 'checkbox' ? (event.target as HTMLInputElement).checked : event.target.value;
      setWrapAdvanced((prev) => ({ ...prev, [field]: value as never }));
    };

  const handleUnwrapAdvancedChange =
    (field: keyof UnwrapAdvancedState) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.type === 'checkbox' ? (event.target as HTMLInputElement).checked : event.target.value;
      setUnwrapAdvanced((prev) => ({ ...prev, [field]: value as never }));
    };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting.on();
    setResult(null);
    setProofPreview(null);
    setError(null);

    try {
      if (!wallet.publicKey) {
        throw new Error('Connect your wallet before converting.');
      }
      if (!mintConfig) {
        throw new Error('Select a supported token.');
      }

      const poolId = mintConfig.poolId;
      const mintId = mintConfig.originMint;

      if (mode === 'to-private') {
        const payload = {
          oldRoot: '0',
          amount,
          recipient: wallet.publicKey.toBase58(),
          depositId: wrapAdvanced.depositId,
          poolId,
          blinding: wrapAdvanced.blinding,
          mintId
        };

        let proofResponse: ProofResponse | null = null;
        if (wrapAdvanced.useProofRpc) {
          proofResponse = await proofClient.requestProof('wrap', payload);
          setProofPreview(proofResponse);
        }

        await wrapSdk({
          connection,
          wallet,
          originMint,
          amount: BigInt(amount),
          poolId,
          depositId: wrapAdvanced.depositId,
          blinding: wrapAdvanced.blinding,
          proof: wrapAdvanced.useProofRpc ? proofResponse : null,
          commitmentHint: proofResponse?.publicInputs?.[2] ?? null,
          recipient: wallet.publicKey.toBase58()
        });

        setResult(`Shielded ${amount} into ${zTokenSymbol}.`);
      } else {
        const destinationKey = await resolvePublicKey(unwrapAdvanced.destination, wallet.publicKey);
        const payload = {
          oldRoot: '0',
          amount,
          fee: unwrapAdvanced.exitFee,
          destPubkey: destinationKey.toBase58(),
          mode: 'origin',
          mintId,
          poolId,
          noteId: unwrapAdvanced.noteId,
          spendingKey: unwrapAdvanced.spendingKey
        };

        let proofResponse: ProofResponse | null = null;
        if (unwrapAdvanced.useProofRpc) {
          proofResponse = await proofClient.requestProof('unwrap', payload);
          setProofPreview(proofResponse);
        }

        if (!proofResponse) {
          throw new Error('Proof RPC must be enabled for unshield.');
        }

        await unwrapSdk({
          connection,
          wallet,
          originMint,
          amount: BigInt(amount),
          poolId,
          destination: destinationKey.toBase58(),
          mode: 'origin',
          proof: proofResponse
        });

        setResult(`Redeemed ${amount} ${mintConfig.symbol}.`);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting.off();
    }
  };

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      bg="rgba(10, 14, 30, 0.85)"
      p={{ base: 6, md: 10 }}
      rounded="3xl"
      border="1px solid rgba(59,205,255,0.25)"
      boxShadow="0 0 45px rgba(59,205,255,0.25)"
    >
      <Stack spacing={6}>
        <Stack spacing={2}>
          <Heading size="lg" color="brand.100">
            Convert between public tokens and zTokens
          </Heading>
          <Text color="whiteAlpha.700">
            Shield value into privacy-preserving zTokens or redeem back into the public mint. The form adapts to the
            direction you choose, keeping the advanced cryptography behind the scenes.
          </Text>
        </Stack>

        <FormControl>
          <FormLabel color="whiteAlpha.700">Mode</FormLabel>
          <Select value={mode} onChange={handleModeChange} bg="rgba(6, 10, 26, 0.85)">
            <option value="to-private">Public → Private (mint zTokens)</option>
            <option value="to-public">Private → Public (redeem zTokens)</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel color="whiteAlpha.700">Token</FormLabel>
          <Select value={originMint} onChange={(event) => setOriginMint(event.target.value)} bg="rgba(6, 10, 26, 0.85)">
            {MINTS.map((mint) => (
              <option key={mint.originMint} value={mint.originMint}>
                {mint.symbol}
              </option>
            ))}
          </Select>
          <FormHelperText color="whiteAlpha.500">
            Private balance will appear as {zTokenSymbol}.
          </FormHelperText>
        </FormControl>

        <FormControl isRequired>
          <FormLabel color="whiteAlpha.700">Amount (in base units)</FormLabel>
          <NumberInput min={0} value={amount} onChange={(valueString) => setAmount(valueString)}>
            <NumberInputField placeholder="0" />
          </NumberInput>
        </FormControl>

        <Box bg="rgba(4, 8, 20, 0.95)" rounded="xl" p={4} border="1px solid rgba(59,205,255,0.15)">
          <Text fontSize="sm" color="whiteAlpha.600">
            You&apos;ll receive:
          </Text>
          <HStack justify="space-between" mt={2}>
            <Text fontSize="lg" color="brand.200" fontWeight="semibold">
              {mode === 'to-private' ? zTokenSymbol : mintConfig?.symbol ?? 'TOKEN'}
            </Text>
            <Text fontSize="sm" color="whiteAlpha.600">
              Direction: {mode === 'to-private' ? 'Shielding (wrap)' : 'Redeeming (unwrap)'}
            </Text>
          </HStack>
        </Box>

        <Button variant="link" color="brand.200" onClick={setShowAdvanced.toggle} alignSelf="flex-start">
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </Button>

        <Collapse in={showAdvanced} animateOpacity>
          <Box bg="rgba(4, 8, 20, 0.95)" rounded="xl" p={5} border="1px solid rgba(59,205,255,0.15)">
            <Stack spacing={4}>
              {mode === 'to-private' ? (
                <>
                  <Text fontWeight="semibold" color="brand.100">
                    Shielding parameters
                  </Text>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Wrap identifier</FormLabel>
                    <Input value={wrapAdvanced.depositId} onChange={handleWrapAdvancedChange('depositId')} />
                    <FormHelperText color="whiteAlpha.500">
                      Auto-generated to bind your proof to this deposit.
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Blinding</FormLabel>
                    <Input value={wrapAdvanced.blinding} onChange={handleWrapAdvancedChange('blinding')} />
                    <FormHelperText color="whiteAlpha.500">
                      Randomised each time to keep the resulting note unlinkable.
                    </FormHelperText>
                  </FormControl>
                  <FormControl display="flex" alignItems="center">
                    <FormLabel htmlFor="wrapRpc" mb="0" color="whiteAlpha.700">
                      Use Proof RPC helper
                    </FormLabel>
                    <Switch
                      id="wrapRpc"
                      colorScheme="teal"
                      isChecked={wrapAdvanced.useProofRpc}
                      onChange={handleWrapAdvancedChange('useProofRpc')}
                    />
                  </FormControl>
                </>
              ) : (
                <>
                  <Text fontWeight="semibold" color="brand.100">
                    Redeem parameters
                  </Text>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Destination public key</FormLabel>
                    <Input
                      value={unwrapAdvanced.destination}
                      onChange={handleUnwrapAdvancedChange('destination')}
                      placeholder="Defaults to your connected wallet"
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Exit fee (lamports)</FormLabel>
                    <Input value={unwrapAdvanced.exitFee} onChange={handleUnwrapAdvancedChange('exitFee')} />
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Note identifier</FormLabel>
                    <Input value={unwrapAdvanced.noteId} onChange={handleUnwrapAdvancedChange('noteId')} />
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Spending key</FormLabel>
                    <Input value={unwrapAdvanced.spendingKey} onChange={handleUnwrapAdvancedChange('spendingKey')} />
                  </FormControl>
                  <FormControl display="flex" alignItems="center">
                    <FormLabel htmlFor="unwrapRpc" mb="0" color="whiteAlpha.700">
                      Use Proof RPC helper
                    </FormLabel>
                    <Switch
                      id="unwrapRpc"
                      colorScheme="teal"
                      isChecked={unwrapAdvanced.useProofRpc}
                      onChange={handleUnwrapAdvancedChange('useProofRpc')}
                    />
                  </FormControl>
                </>
              )}
            </Stack>
          </Box>
        </Collapse>

        <Button
          type="submit"
          size="lg"
          variant="glow"
          isLoading={isSubmitting}
          loadingText={mode === 'to-private' ? 'Shielding' : 'Redeeming'}
          isDisabled={!amount}
        >
          {wallet.publicKey ? 'Submit conversion' : 'Connect wallet to proceed'}
        </Button>

        {result && (
          <Alert status="success" variant="subtle">
            <AlertIcon />
            <AlertDescription>{result}</AlertDescription>
          </Alert>
        )}

        {proofPreview && (
          <Box bg="rgba(4, 8, 20, 0.95)" rounded="xl" p={4} border="1px solid rgba(59,205,255,0.15)" fontFamily="mono">
            <Text fontWeight="semibold" color="brand.100">
              Proof preview
            </Text>
            <Text fontSize="sm" color="whiteAlpha.700" mt={2}>
              VK hash: {proofPreview.verifyingKeyHash || 'local'}
            </Text>
            <Text fontSize="sm" color="whiteAlpha.700" mt={1}>
              Public inputs: {proofPreview.publicInputs.join(', ')}
            </Text>
          </Box>
        )}

        {error && (
          <Alert status="error" variant="subtle">
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Stack>
    </Box>
  );
}

