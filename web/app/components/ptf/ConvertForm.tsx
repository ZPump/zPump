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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { MINTS, MintConfig } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import { wrap as wrapSdk, unwrap as unwrapSdk, resolvePublicKey } from '../../lib/sdk';
import { IndexerClient, IndexerNote } from '../../lib/indexerClient';
import { getCachedRoots, setCachedRoots, getCachedNullifiers, setCachedNullifiers } from '../../lib/indexerCache';
import { deriveCommitmentTree } from '../../lib/onchain/pdas';
import { commitmentToHex, decodeCommitmentTree } from '../../lib/onchain/commitmentTree';

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
  viewKey: string;
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
  viewKey: '',
    useProofRpc: true
  });

  const [result, setResult] = useState<string | null>(null);
  const [proofPreview, setProofPreview] = useState<ProofResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<{ current: string; recent: string[]; source: string } | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [isLoadingRoots, setLoadingRoots] = useState<boolean>(false);
  const [nullifierState, setNullifierState] = useState<{ values: string[]; source?: string } | null>(null);
  const [nullifierError, setNullifierError] = useState<string | null>(null);
  const [isLoadingNullifiers, setLoadingNullifiers] = useState<boolean>(false);
  const [notesSnapshot, setNotesSnapshot] = useState<{ viewKey: string; notes: IndexerNote[]; source?: string } | null>(
    null
  );
  const [notesError, setNotesError] = useState<string | null>(null);
  const [isLoadingNotes, setLoadingNotes] = useState<boolean>(false);

  const mintConfig = useMemo<MintConfig | undefined>(
    () => MINTS.find((mint) => mint.originMint === originMint),
    [originMint]
  );

  const zTokenSymbol = useMemo(() => `z${mintConfig?.symbol ?? 'TOKEN'}`, [mintConfig?.symbol]);

  const proofClient = useMemo(() => new ProofClient(), []);
  const indexerClient = useMemo(() => new IndexerClient(), []);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const normaliseField = (value: string) => {
    if (!value) {
      return value;
    }
    if (value.startsWith('0x') || value.startsWith('0X')) {
      const trimmed = value.slice(2).toLowerCase() || '0';
      return `0x${trimmed}`;
    }
    if (/^\d+$/.test(value)) {
      try {
        return `0x${BigInt(value).toString(16)}`;
      } catch {
        return value;
      }
    }
    return value;
  };

  const fetchRootsFromChain = useCallback(
    async (mint: string) => {
      const mintKey = new PublicKey(mint);
      const treeKey = deriveCommitmentTree(mintKey);
      const accountInfo = await connection.getAccountInfo(treeKey);
      if (!accountInfo) {
        throw new Error('Commitment tree account missing on-chain');
      }
      const state = decodeCommitmentTree(new Uint8Array(accountInfo.data));
      return {
        current: commitmentToHex(state.currentRoot),
        recent: [],
        source: 'chain'
      };
    },
    [connection]
  );

  const refreshRoots = useCallback(async () => {
    if (!originMint) {
      return null;
    }
    setLoadingRoots(true);
    setRootsError(null);
    try {
      const result = await indexerClient.getRoots(originMint);
      if (result) {
        const parsed = {
          current: normaliseField(result.current),
          recent: result.recent.map(normaliseField),
          source: result.source ?? 'indexer'
        };
        if (mountedRef.current) {
          setRoots(parsed);
          setCachedRoots({ mint: originMint, current: parsed.current, recent: parsed.recent, source: parsed.source });
        }
        return parsed;
      }
      const fallback = await fetchRootsFromChain(originMint);
      if (mountedRef.current) {
        setRoots(fallback);
        setCachedRoots({ mint: originMint, current: fallback.current, recent: fallback.recent, source: fallback.source });
      }
      return fallback;
    } catch (caught) {
      try {
        const fallback = await fetchRootsFromChain(originMint);
        if (mountedRef.current) {
          setRoots(fallback);
          setCachedRoots({ mint: originMint, current: fallback.current, recent: fallback.recent, source: fallback.source });
        }
        return fallback;
      } catch (chainError) {
        if (mountedRef.current) {
          setRoots(null);
          setRootsError((caught as Error).message ?? 'Failed to fetch roots');
        }
        throw chainError;
      }
    } finally {
      if (mountedRef.current) {
        setLoadingRoots(false);
      }
    }
  }, [fetchRootsFromChain, indexerClient, originMint]);

  useEffect(() => {
    const cached = originMint ? getCachedRoots(originMint) : null;
    if (cached) {
      setRoots({
        current: cached.current,
        recent: cached.recent,
        source: cached.source ?? 'cache'
      });
    }
    void refreshRoots();
  }, [originMint, refreshRoots]);

  const resolvedOldRoot = roots?.current ?? null;

  const refreshNullifiers = useCallback(
    async () => {
      if (!originMint) {
        return [] as string[];
      }
      setLoadingNullifiers(true);
      setNullifierError(null);
    try {
      const result = await indexerClient.getNullifiers(originMint);
      const values = result ? result.nullifiers.map(normaliseField) : [];
      if (mountedRef.current) {
        const nextState = { values, source: result?.source };
        setNullifierState(nextState);
        setCachedNullifiers({ mint: originMint, values, source: nextState.source });
      }
      return values;
      } catch (caught) {
        if (mountedRef.current) {
          setNullifierState(null);
          setNullifierError((caught as Error).message ?? 'Failed to fetch nullifiers');
        }
        return [] as string[];
      } finally {
        if (mountedRef.current) {
          setLoadingNullifiers(false);
        }
      }
    },
    [indexerClient, originMint]
  );

  useEffect(() => {
    const cached = originMint ? getCachedNullifiers(originMint) : null;
    if (cached) {
      setNullifierState({ values: cached.values, source: cached.source });
    }
    void refreshNullifiers();
  }, [originMint, refreshNullifiers]);

  const nullifierList = nullifierState?.values ?? [];

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

  const handleFetchNotes = async () => {
    const viewKey = unwrapAdvanced.viewKey.trim();
    if (!viewKey) {
      setNotesSnapshot(null);
      setNotesError('Enter a viewing key to scan notes.');
      return;
    }
    setNotesError(null);
    setLoadingNotes(true);
    try {
      const result = await indexerClient.getNotes(viewKey);
      if (mountedRef.current) {
        if (result) {
          const notes = result.notes.map((note) => ({
            ...note,
            commitment: normaliseField(note.commitment)
          }));
          setNotesSnapshot({ viewKey: result.viewKey, notes, source: result.source });
        } else {
          setNotesSnapshot({ viewKey, notes: [], source: undefined });
        }
      }
    } catch (caught) {
      if (mountedRef.current) {
        setNotesSnapshot(null);
        setNotesError((caught as Error).message ?? 'Failed to fetch notes');
      }
    } finally {
      if (mountedRef.current) {
        setLoadingNotes(false);
      }
    }
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

      let rootValue = resolvedOldRoot;
      if (!rootValue) {
        const latest = await refreshRoots();
        rootValue = latest?.current ?? null;
      }

      if (!rootValue) {
        throw new Error('Unable to resolve the current commitment tree root. Refresh and try again.');
      }

      if (mode === 'to-private') {
        const payload = {
          oldRoot: rootValue,
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
          oldRoot: rootValue,
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

        const proofNullifier = proofResponse.publicInputs?.[2];
        const normalisedNullifier = proofNullifier ? normaliseField(proofNullifier) : null;
        if (!normalisedNullifier) {
          throw new Error('Proof payload missing nullifier public input.');
        }

        const latestNullifiers = await refreshNullifiers();
        if (latestNullifiers.includes(normalisedNullifier)) {
          throw new Error('This note appears to be already spent. Refresh and pick a different note.');
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
      void refreshRoots();
      void refreshNullifiers();
      if (notesSnapshot) {
        void handleFetchNotes();
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

        <FormControl>
          <FormLabel color="whiteAlpha.700">Commitment tree root</FormLabel>
          <HStack spacing={3} align="center">
            <Text fontFamily="mono" fontSize="sm" color="whiteAlpha.700">
              {roots?.current ?? '…'}
            </Text>
            <Button size="xs" variant="outline" onClick={() => void refreshRoots()} isLoading={isLoadingRoots}>
              Refresh
            </Button>
          </HStack>
          {roots?.source && (
            <FormHelperText color="whiteAlpha.500">Source: {roots.source}</FormHelperText>
          )}
          {roots?.recent.length ? (
            <FormHelperText color="whiteAlpha.500">
              Recent: {roots.recent.slice(0, 3).join(', ')}
              {roots.recent.length > 3 ? '…' : ''}
            </FormHelperText>
          ) : null}
          {rootsError && <FormHelperText color="red.300">{rootsError}</FormHelperText>}
        </FormControl>

        {mode === 'to-public' && (
          <FormControl>
            <FormLabel color="whiteAlpha.700">Known nullifiers</FormLabel>
            <Stack spacing={1} fontFamily="mono" bg="rgba(4, 8, 20, 0.75)" p={3} rounded="md">
              {nullifierList.length ? (
                nullifierList.slice(0, 5).map((entry) => (
                  <Text key={entry} color="whiteAlpha.700" fontSize="sm">
                    {entry}
                  </Text>
                ))
              ) : (
                <Text color="whiteAlpha.500" fontSize="sm">
                  No spent notes recorded for this mint yet.
                </Text>
              )}
              {nullifierList.length > 5 && (
                <Text color="whiteAlpha.500" fontSize="xs">
                  + {nullifierList.length - 5} additional nullifiers
                </Text>
              )}
            </Stack>
            <HStack spacing={3} mt={2}>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void refreshNullifiers()}
                isLoading={isLoadingNullifiers}
              >
                Refresh nullifiers
              </Button>
              {nullifierState?.source && (
                <Text fontSize="xs" color="whiteAlpha.500">
                  Source: {nullifierState.source}
                </Text>
              )}
            </HStack>
            {nullifierError && <FormHelperText color="red.300">{nullifierError}</FormHelperText>}
          </FormControl>
        )}

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
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Viewing key (optional)</FormLabel>
                    <HStack spacing={3}>
                      <Input
                        value={unwrapAdvanced.viewKey}
                        onChange={handleUnwrapAdvancedChange('viewKey')}
                        placeholder="Fetch indexed notes with your view key"
                      />
                      <Button size="sm" variant="outline" onClick={() => void handleFetchNotes()} isLoading={isLoadingNotes}>
                        Scan
                      </Button>
                    </HStack>
                    <FormHelperText color="whiteAlpha.500">
                      We&apos;ll query the configured indexer for note commitments linked to this key.
                    </FormHelperText>
                    {notesError && <FormHelperText color="red.300">{notesError}</FormHelperText>}
                    {notesSnapshot && (
                      <Box mt={3} bg="rgba(3, 6, 16, 0.85)" p={3} rounded="md" border="1px solid rgba(59,205,255,0.1)">
                        <Text fontSize="sm" color="whiteAlpha.600">
                          Found {notesSnapshot.notes.length} notes
                          {notesSnapshot.source ? ` (source: ${notesSnapshot.source})` : ''}
                        </Text>
                        <Stack spacing={2} mt={2} fontFamily="mono" fontSize="xs">
                          {notesSnapshot.notes.length === 0 && (
                            <Text color="whiteAlpha.500">No notes visible for this viewing key.</Text>
                          )}
                          {notesSnapshot.notes.slice(0, 3).map((note) => (
                            <Box key={`${note.commitment}-${note.slot}`} p={2} bg="rgba(0,0,0,0.2)" rounded="md">
                              <Text color="whiteAlpha.700">Commitment: {note.commitment}</Text>
                              <Text color="whiteAlpha.500">Mint: {note.mint}</Text>
                              <Text color="whiteAlpha.500">Slot: {note.slot}</Text>
                            </Box>
                          ))}
                          {notesSnapshot.notes.length > 3 && (
                            <Text color="whiteAlpha.500">+ {notesSnapshot.notes.length - 3} additional notes…</Text>
                          )}
                        </Stack>
                      </Box>
                    )}
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

