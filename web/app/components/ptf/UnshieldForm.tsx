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
  Radio,
  RadioGroup,
  Select,
  Stack,
  Switch,
  Text
} from '@chakra-ui/react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useMemo, useState } from 'react';
import { MINTS } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import { resolvePublicKey, unshield as unshieldSdk } from '../../lib/sdk';

interface UnshieldState {
  originMint: string;
  amount: string;
  fee: string;
  destination: string;
  mode: 'origin' | 'ptkn';
  noteId: string;
  spendingKey: string;
  useProofRpc: boolean;
}

const DEFAULT_STATE: UnshieldState = {
  originMint: MINTS[0]?.originMint ?? '',
  amount: '1',
  fee: '0',
  destination: '',
  mode: 'origin',
  noteId: '101',
  spendingKey: '202',
  useProofRpc: true
};

export function UnshieldForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<UnshieldState>(DEFAULT_STATE);
  const [isSubmitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [proof, setProof] = useState<ProofResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mintConfig = useMemo(
    () => MINTS.find((mint) => mint.originMint === state.originMint) ?? MINTS[0],
    [state.originMint]
  );

  const proofClient = useMemo(() => new ProofClient(), []);

  const fallbackProof: ProofResponse = useMemo(() => ({
    proof: 'client-side',
    publicInputs: [],
    verifyingKeyHash: ''
  }), []);

  const handleChange = (field: keyof UnshieldState) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.type === 'checkbox' ? (event.target as HTMLInputElement).checked : event.target.value;
    setState((prev) => ({ ...prev, [field]: value }));
  };

  const handleSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const { value } = event.target;
    setState((prev) => ({ ...prev, originMint: value }));
  };

  const handleModeChange = (mode: 'origin' | 'ptkn') => {
    setState((prev) => ({ ...prev, mode }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    setError(null);
    setProof(null);

    try {
      if (!wallet.publicKey) {
        throw new Error('Connect your wallet before unshielding.');
      }
      if (state.mode === 'ptkn' && !mintConfig?.features.twinEnabled) {
        throw new Error('This mint has not enabled privacy twin withdrawals.');
      }

      const payload = {
        oldRoot: '0',
        amount: state.amount,
        fee: state.fee,
        destPubkey: state.destination || wallet.publicKey?.toBase58() || '',
        mode: state.mode,
        mintId: mintConfig?.originMint ?? '',
        poolId: mintConfig?.poolId ?? '',
        noteId: state.noteId,
        spendingKey: state.spendingKey
      };

      let proofResponse: ProofResponse | null = null;
      if (state.useProofRpc) {
        proofResponse = await proofClient.requestProof('unshield', payload);
        setProof(proofResponse);
      }

      const resolvedDestination = await resolvePublicKey(state.destination, wallet.publicKey!);

      const signature = await unshieldSdk({
        connection,
        wallet,
        originMint: state.originMint,
        amount: BigInt(state.amount),
        poolId: mintConfig?.poolId ?? '',
        destination: resolvedDestination.toBase58(),
        mode: state.mode,
        proof: proofResponse ?? fallbackProof
      });

      setResult(signature);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box as="section" bg="rgba(8,12,40,0.6)" p={8} rounded="2xl" boxShadow="xl" border="1px solid" borderColor="whiteAlpha.200">
      <form onSubmit={handleSubmit}>
        <Stack spacing={6}>
          <Heading size="lg">Unshield tokens</Heading>
          <Text color="whiteAlpha.700">
            Exit the private pool into a public address. The proof spends your note, derives a
            nullifier, and instructs the Vault or twin mint program to deliver funds on-chain.
          </Text>

          <FormControl>
            <FormLabel>Origin mint</FormLabel>
            <Select value={state.originMint} onChange={handleSelect} bg="blackAlpha.500">
              {MINTS.map((mint) => (
                <option key={mint.originMint} value={mint.originMint}>
                  {mint.symbol} ({mint.originMint.slice(0, 4)}…)
                </option>
              ))}
            </Select>
          </FormControl>

          <FormControl isRequired>
            <FormLabel>Amount</FormLabel>
            <Input value={state.amount} onChange={handleChange('amount')} type="number" min="0" step="0.000001" bg="blackAlpha.500" />
          </FormControl>

          <FormControl>
            <FormLabel>Exit fee</FormLabel>
            <Input value={state.fee} onChange={handleChange('fee')} type="number" min="0" step="0.000001" bg="blackAlpha.500" />
            <FormHelperText>Protocol default is 5 bps. Adjust if the mint overrides it.</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Destination public key</FormLabel>
            <Input value={state.destination} onChange={handleChange('destination')} placeholder="Defaults to your connected wallet" bg="blackAlpha.500" />
          </FormControl>

          <FormControl isRequired>
            <FormLabel>Note identifier</FormLabel>
            <Input value={state.noteId} onChange={handleChange('noteId')} bg="blackAlpha.500" />
            <FormHelperText>Matches the encrypted payload in your note list.</FormHelperText>
          </FormControl>

          <FormControl isRequired>
            <FormLabel>Spending key</FormLabel>
            <Input value={state.spendingKey} onChange={handleChange('spendingKey')} bg="blackAlpha.500" />
          </FormControl>

          <FormControl as="fieldset">
            <FormLabel as="legend">Withdrawal rail</FormLabel>
            <RadioGroup value={state.mode} onChange={(value) => handleModeChange(value as 'origin' | 'ptkn')}>
              <Stack direction="row" spacing={6}>
                <Radio value="origin">Redeem origin mint</Radio>
                <Radio value="ptkn" isDisabled={!mintConfig?.features.twinEnabled}>
                  Mint privacy twin
                </Radio>
              </Stack>
            </RadioGroup>
            {!mintConfig?.features.twinEnabled && (
              <FormHelperText>Enable twin minting via governance before using this rail.</FormHelperText>
            )}
          </FormControl>

          <FormControl display="flex" alignItems="center">
            <FormLabel htmlFor="useProofRpc" mb="0">
              Use Proof RPC helper
            </FormLabel>
            <Switch id="useProofRpc" isChecked={state.useProofRpc} onChange={handleChange('useProofRpc')} colorScheme="teal" />
          </FormControl>

          <Button type="submit" colorScheme="orange" size="lg" isLoading={isSubmitting} loadingText="Unshielding">
            Generate proof &amp; submit
          </Button>

          {result && (
            <Alert status="success" variant="subtle">
              <AlertIcon />
              <AlertDescription>
                Exit transaction sent. Signature <Text as="span" fontFamily="mono">{result}</Text>
              </AlertDescription>
            </Alert>
          )}

          {proof && (
            <Box bg="blackAlpha.600" p={4} rounded="md" fontFamily="mono" overflowX="auto">
              <Text fontWeight="semibold" mb={2}>
                Proof preview
              </Text>
              <Text fontSize="sm">VK hash: {proof.verifyingKeyHash}</Text>
              <Text fontSize="sm" mt={1}>
                Public inputs: {proof.publicInputs.join(', ')}
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
      </form>
    </Box>
  );
}
