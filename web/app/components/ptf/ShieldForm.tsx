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
  Select,
  Stack,
  Switch,
  Text,
  Textarea
} from '@chakra-ui/react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMemo, useState } from 'react';
import { MINTS } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import { shield as shieldSdk } from '../../lib/sdk';

interface ShieldState {
  originMint: string;
  amount: string;
  depositId: string;
  viewKey: string;
  blinding: string;
  useProofRpc: boolean;
  noteMemo: string;
}

const DEFAULT_STATE: ShieldState = {
  originMint: MINTS[0]?.originMint ?? '',
  amount: '1',
  depositId: '1',
  viewKey: '',
  blinding: '42',
  useProofRpc: true,
  noteMemo: ''
};

export function ShieldForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<ShieldState>(DEFAULT_STATE);
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

  const handleChange = (field: keyof ShieldState) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.type === 'checkbox' ? (event.target as HTMLInputElement).checked : event.target.value;
    setState((prev) => ({ ...prev, [field]: value }));
  };

  const handleSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = event.target;
    setState((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    setProof(null);

    try {
      if (!wallet.publicKey) {
        throw new Error('Connect your wallet before shielding.');
      }
      const payload = {
        oldRoot: '0',
        amount: state.amount,
        recipient: wallet.publicKey?.toBase58() ?? '',
        depositId: state.depositId,
        poolId: mintConfig?.poolId ?? '',
        blinding: state.blinding,
        mintId: mintConfig?.originMint ?? ''
      };

      let proofResponse: ProofResponse | null = null;
      if (state.useProofRpc) {
        proofResponse = await proofClient.requestProof('shield', payload);
        setProof(proofResponse);
      }

      const signature = await shieldSdk({
        connection,
        wallet,
        originMint: state.originMint,
        amount: BigInt(state.amount),
        poolId: mintConfig?.poolId ?? '',
        commitment: proofResponse?.publicInputs?.[2] ?? '0x0',
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
          <Heading size="lg">Shield tokens</Heading>
          <Text color="whiteAlpha.700">
            Shielding moves public SPL tokens into the privacy pool. Your wallet crafts a deposit
            note commitment and submits a Groth16 proof that authorises the Vault transfer.
          </Text>

          <FormControl>
            <FormLabel>Origin mint</FormLabel>
            <Select name="originMint" value={state.originMint} onChange={handleSelect} bg="blackAlpha.500">
              {MINTS.map((mint) => (
                <option key={mint.originMint} value={mint.originMint}>
                  {mint.symbol} ({mint.originMint.slice(0, 4)}…)
                </option>
              ))}
            </Select>
            <FormHelperText>Mint decimals: {mintConfig?.decimals}</FormHelperText>
          </FormControl>

          <FormControl isRequired>
            <FormLabel>Amount</FormLabel>
            <Input value={state.amount} onChange={handleChange('amount')} type="number" min="0" step="0.000001" bg="blackAlpha.500" />
            <FormHelperText>Amounts are denominated in the mint&apos;s smallest unit.</FormHelperText>
          </FormControl>

          <FormControl isRequired>
            <FormLabel>Deposit identifier</FormLabel>
            <Input value={state.depositId} onChange={handleChange('depositId')} bg="blackAlpha.500" />
            <FormHelperText>Bind the shield proof to the pending Vault deposit.</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Viewing key (optional)</FormLabel>
            <Input value={state.viewKey} onChange={handleChange('viewKey')} bg="blackAlpha.500" />
            <FormHelperText>Provide a viewing key to indexers if you want to auto-sync notes.</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Blinding</FormLabel>
            <Input value={state.blinding} onChange={handleChange('blinding')} bg="blackAlpha.500" />
            <FormHelperText>Use a unique random value to keep the note unlinkable.</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Memo (encrypted)</FormLabel>
            <Textarea value={state.noteMemo} onChange={handleChange('noteMemo')} placeholder="Optional encrypted payload for your viewing key" bg="blackAlpha.500" />
          </FormControl>

          <FormControl display="flex" alignItems="center">
            <FormLabel htmlFor="useProofRpc" mb="0">
              Use Proof RPC helper
            </FormLabel>
            <Switch id="useProofRpc" isChecked={state.useProofRpc} onChange={handleChange('useProofRpc')} colorScheme="teal" />
          </FormControl>

          <Button type="submit" colorScheme="teal" size="lg" isLoading={isSubmitting} loadingText="Shielding">
            Generate proof &amp; submit
          </Button>

          {result && (
            <Alert status="success" variant="subtle">
              <AlertIcon />
              <AlertDescription>
                Shield transaction sent. Signature <Text as="span" fontFamily="mono">{result}</Text>
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
