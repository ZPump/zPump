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
import { poseidonHashMany } from '../../lib/onchain/poseidon';

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
  noteAmount: string;
  changeAmount: string;
  changeRecipient: string;
  changeBlinding: string;
  changeAmountBlinding: string;
  autoChange: boolean;
}

const createRandomSeed = () => Math.floor(Math.random() * 1_000_000).toString();

interface StoredNoteEntry {
  id: string;
  label: string;
  noteId: string;
  spendingKey: string;
  amount: string;
  changeRecipient?: string;
}

const SAVED_NOTES_KEY = 'ptf.savedNotes';

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;

const generateRandomFieldHex = () => {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }
  const fallback = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16);
  return `0x${fallback}`;
};

export function ConvertForm() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [mode, setMode] = useState<ConvertMode>('to-private');
  const [originMint, setOriginMint] = useState<string>(MINTS[0]?.originMint ?? '');
  const [amount, setAmount] = useState<string>('1');
  const [isSubmitting, setSubmitting] = useBoolean(false);
  const [showAdvanced, setShowAdvanced] = useBoolean(false);
  const [redeemMode, setRedeemMode] = useState<'origin' | 'ztkn'>('origin');

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
    useProofRpc: true,
    noteAmount: '',
    changeAmount: '',
    changeRecipient: '',
    changeBlinding: '',
    changeAmountBlinding: '',
    autoChange: true
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
  const [storedNotes, setStoredNotes] = useState<StoredNoteEntry[]>([]);
  const [selectedStoredNoteId, setSelectedStoredNoteId] = useState<string | null>(null);
  const [noteLabelDraft, setNoteLabelDraft] = useState<string>('');
  const [nullifierPreview, setNullifierPreview] = useState<string | null>(null);
  const [nullifierPreviewError, setNullifierPreviewError] = useState<string | null>(null);

  const mintConfig = useMemo<MintConfig | undefined>(
    () => MINTS.find((mint) => mint.originMint === originMint),
    [originMint]
  );

  const zTokenSymbol = useMemo(() => `z${mintConfig?.symbol ?? 'TOKEN'}`, [mintConfig?.symbol]);
  const twinRedemptionAvailable = useMemo(
    () => Boolean(mintConfig?.features?.zTokenEnabled && mintConfig?.zTokenMint),
    [mintConfig?.features?.zTokenEnabled, mintConfig?.zTokenMint]
  );
  const redeemDisplaySymbol = useMemo(() => {
    if (mode === 'to-private') {
      return zTokenSymbol;
    }
    if (redeemMode === 'ztkn' && twinRedemptionAvailable) {
      return `${mintConfig?.symbol ?? 'TOKEN'} twin`;
    }
    return mintConfig?.symbol ?? 'TOKEN';
  }, [mintConfig?.symbol, mode, redeemMode, twinRedemptionAvailable, zTokenSymbol]);

  const proofClient = useMemo(() => new ProofClient(), []);
  const indexerClient = useMemo(() => new IndexerClient(), []);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'to-public' || !twinRedemptionAvailable) {
      setRedeemMode('origin');
    }
  }, [mode, twinRedemptionAvailable]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(SAVED_NOTES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredNoteEntry[];
        if (Array.isArray(parsed)) {
          setStoredNotes(parsed);
        }
      }
    } catch (error) {
      console.warn('Failed to load saved notes', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(SAVED_NOTES_KEY, JSON.stringify(storedNotes));
    } catch (error) {
      console.warn('Failed to persist saved notes', error);
    }
  }, [storedNotes]);

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
      } catch {
        if (mountedRef.current) {
          setRoots(null);
          setRootsError(
            (caught as Error).message ??
              'Commitment tree account not found. Run bootstrap-private-devnet or select a registered mint.'
          );
        }
        return null;
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
  const computedChangeAmount = useMemo(() => {
    try {
      const baseAmount = amount ? BigInt(amount) : 0n;
      const feeAmount = unwrapAdvanced.exitFee ? BigInt(unwrapAdvanced.exitFee) : 0n;
      const totalOut = baseAmount + feeAmount;
      if (unwrapAdvanced.autoChange) {
        const noteTotal = unwrapAdvanced.noteAmount ? BigInt(unwrapAdvanced.noteAmount) : totalOut;
        return noteTotal - totalOut;
      }
      return unwrapAdvanced.changeAmount ? BigInt(unwrapAdvanced.changeAmount) : 0n;
    } catch {
      return null;
    }
  }, [amount, unwrapAdvanced.autoChange, unwrapAdvanced.changeAmount, unwrapAdvanced.exitFee, unwrapAdvanced.noteAmount]);

  const handleModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setMode(event.target.value as ConvertMode);
    setResult(null);
    setProofPreview(null);
    setError(null);
    setSelectedStoredNoteId(null);
    setNoteLabelDraft('');
    setNullifierPreview(null);
    setNullifierPreviewError(null);
    setRedeemMode('origin');
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

  const handleSelectStoredNote = (noteId: string) => {
    setSelectedStoredNoteId(noteId || null);
    const entry = storedNotes.find((note) => note.id === noteId);
    if (!entry) {
      return;
    }
    setUnwrapAdvanced((prev) => ({
      ...prev,
      noteId: entry.noteId,
      spendingKey: entry.spendingKey,
      noteAmount: entry.amount,
      changeRecipient: entry.changeRecipient ?? prev.changeRecipient
    }));
    setNoteLabelDraft(entry.label);
  };

  const handleSaveStoredNote = () => {
    const noteId = unwrapAdvanced.noteId.trim();
    const spendingKey = unwrapAdvanced.spendingKey.trim();
    if (!noteId || !spendingKey) {
      setError('Provide a note identifier and spending key before saving.');
      return;
    }
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const label = noteLabelDraft.trim() || `Note ${storedNotes.length + 1}`;
    const entry: StoredNoteEntry = {
      id,
      label,
      noteId,
      spendingKey,
      amount: unwrapAdvanced.noteAmount.trim() || amount || '0',
      changeRecipient: unwrapAdvanced.changeRecipient.trim() || undefined
    };
    setStoredNotes((prev) => {
      const filtered = prev.filter((item) => item.noteId !== entry.noteId || item.spendingKey !== entry.spendingKey);
      return [...filtered, entry];
    });
    setSelectedStoredNoteId(entry.id);
  };

  const handleRemoveStoredNote = (id: string) => {
    setStoredNotes((prev) => prev.filter((note) => note.id !== id));
    if (selectedStoredNoteId === id) {
      setSelectedStoredNoteId(null);
      setNoteLabelDraft('');
    }
  };

  const handleGenerateBlindings = () => {
    const newBlinding = generateRandomFieldHex();
    const newAmountBlinding = generateRandomFieldHex();
    setUnwrapAdvanced((prev) => ({
      ...prev,
      changeBlinding: newBlinding,
      changeAmountBlinding: newAmountBlinding
    }));
  };

  const handlePreviewNullifier = async () => {
    setNullifierPreviewError(null);
    try {
      const noteIdValue = BigInt(unwrapAdvanced.noteId);
      const spendingKeyValue = BigInt(unwrapAdvanced.spendingKey);
      const hash = await poseidonHashMany([noteIdValue, spendingKeyValue]);
      setNullifierPreview(bytesToHex(hash));
    } catch {
      setNullifierPreview(null);
      setNullifierPreviewError('Unable to derive nullifier. Ensure note id and spending key are valid field values.');
    }
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
        const selectedRedemptionMode = twinRedemptionAvailable ? redeemMode : 'origin';
        const proofMode = selectedRedemptionMode === 'ztkn' ? 'ztkn' : 'origin';

        const parseUnsigned = (value: string, label: string): bigint => {
          try {
            const parsed = BigInt(value);
            if (parsed < 0n) {
              throw new Error();
            }
            return parsed;
          } catch {
            throw new Error(`Invalid ${label}. Enter a non-negative integer.`);
          }
        };

        const amountValue = parseUnsigned(amount, 'amount');
        const feeValue = unwrapAdvanced.exitFee ? parseUnsigned(unwrapAdvanced.exitFee, 'exit fee') : 0n;
        let noteAmountValue = unwrapAdvanced.noteAmount
          ? parseUnsigned(unwrapAdvanced.noteAmount, 'note amount')
          : amountValue + feeValue;

        const totalOutflow = amountValue + feeValue;
        if (noteAmountValue < totalOutflow) {
          throw new Error('Note amount must cover the requested amount plus exit fee.');
        }

        let changeAmountValue: bigint;
        if (unwrapAdvanced.autoChange) {
          changeAmountValue = noteAmountValue - totalOutflow;
        } else if (unwrapAdvanced.changeAmount) {
          changeAmountValue = parseUnsigned(unwrapAdvanced.changeAmount, 'change amount');
        } else {
          changeAmountValue = 0n;
        }

        if (changeAmountValue < 0n) {
          throw new Error('Change amount cannot be negative.');
        }

        let changeRecipientField = unwrapAdvanced.changeRecipient.trim();
        let changeBlindingField = unwrapAdvanced.changeBlinding.trim();
        let changeAmountBlindingField = unwrapAdvanced.changeAmountBlinding.trim();

        if (changeAmountValue > 0n) {
          if (!changeRecipientField) {
            throw new Error('Provide a change recipient field element when change is positive.');
          }
          if (!changeBlindingField) {
            const generated = generateRandomFieldHex();
            changeBlindingField = generated;
            if (mountedRef.current) {
              setUnwrapAdvanced((prev) => ({ ...prev, changeBlinding: generated }));
            }
          }
          if (!changeAmountBlindingField) {
            const generated = generateRandomFieldHex();
            changeAmountBlindingField = generated;
            if (mountedRef.current) {
              setUnwrapAdvanced((prev) => ({ ...prev, changeAmountBlinding: generated }));
            }
          }
        } else {
          changeRecipientField = '';
          changeBlindingField = changeBlindingField || '0x0';
          changeAmountBlindingField = changeAmountBlindingField || '0x0';
        }

        const changePayload = changeAmountValue > 0n
          ? {
              amount: changeAmountValue.toString(),
              recipient: changeRecipientField,
              blinding: changeBlindingField,
              amountBlinding: changeAmountBlindingField
            }
          : undefined;

        const payload = {
          oldRoot: rootValue,
          amount: amountValue.toString(),
          fee: feeValue.toString(),
          destPubkey: destinationKey.toBase58(),
          mode: proofMode,
          mintId,
          poolId,
          noteId: unwrapAdvanced.noteId,
          spendingKey: unwrapAdvanced.spendingKey,
          noteAmount: noteAmountValue.toString(),
          change: changePayload,
          nullifier: nullifierPreview ?? undefined
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
          amount: amountValue,
          poolId,
          destination: destinationKey.toBase58(),
          mode: selectedRedemptionMode,
          proof: proofResponse
        });

        try {
          await indexerClient.appendNullifiers(originMint, [normalisedNullifier]);
          if (mountedRef.current) {
            setNullifierState((prev) => {
              const existing = prev?.values ?? [];
              const nextValues = [
                normalisedNullifier,
                ...existing.filter((value) => value !== normalisedNullifier)
              ];
              const source = prev?.source ?? 'local';
              setCachedNullifiers({ mint: originMint, values: nextValues, source });
              return { values: nextValues, source };
            });
          }
        } catch (caught) {
          console.warn('Failed to persist nullifier to indexer', caught);
        }

        if (selectedRedemptionMode === 'ztkn') {
          setResult(`Minted ${amount} ${mintConfig.symbol} privacy twin tokens.`);
        } else {
        setResult(`Redeemed ${amount} ${mintConfig.symbol}.`);
        }
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
      bg="rgba(18, 16, 14, 0.88)"
      p={{ base: 6, md: 10 }}
      rounded="3xl"
      border="1px solid rgba(245,178,27,0.24)"
      boxShadow="0 0 45px rgba(245, 178, 27, 0.22)"
    >
      <Stack spacing={6}>
        <Stack spacing={2}>
          <Heading size="lg" color="brand.100">
            Convert between public tokens and zTokens
          </Heading>
          <Text color="whiteAlpha.700">
          Shield value into privacy-preserving zPump tokens or redeem back into the public mint.
          </Text>
        </Stack>

        <FormControl>
          <FormLabel color="whiteAlpha.700">Mode</FormLabel>
          <Select value={mode} onChange={handleModeChange} bg="rgba(18, 16, 14, 0.78)">
            <option value="to-private">Public → Private (mint zTokens)</option>
            <option value="to-public">Private → Public (redeem zTokens)</option>
          </Select>
        </FormControl>

        <FormControl>
          <FormLabel color="whiteAlpha.700">Token</FormLabel>
          <Select value={originMint} onChange={(event) => setOriginMint(event.target.value)} bg="rgba(18, 16, 14, 0.78)">
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

        {mode === 'to-public' && twinRedemptionAvailable && (
          <FormControl>
            <FormLabel color="whiteAlpha.700">Redeem to</FormLabel>
            <Select
              value={redeemMode}
              onChange={(event) => setRedeemMode(event.target.value as 'origin' | 'ztkn')}
              bg="rgba(18, 16, 14, 0.78)"
            >
              <option value="origin">Original mint ({mintConfig?.symbol ?? 'TOKEN'})</option>
              <option value="ztkn">Privacy twin ({mintConfig?.symbol ?? 'TOKEN'})</option>
            </Select>
            <FormHelperText color="whiteAlpha.500">
              Choose whether to receive the original token or its privacy twin on exit.
            </FormHelperText>
          </FormControl>
        )}

        {mode === 'to-public' && (
          <FormControl>
            <FormLabel color="whiteAlpha.700">Known nullifiers</FormLabel>
            <Stack spacing={1} fontFamily="mono" bg="rgba(18, 16, 14, 0.74)" p={3} rounded="md">
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

        <Box bg="rgba(20, 18, 14, 0.9)" rounded="xl" p={4} border="1px solid rgba(245,178,27,0.18)">
          <Text fontSize="sm" color="whiteAlpha.600">
            You&apos;ll receive:
          </Text>
          <HStack justify="space-between" mt={2}>
            <Text fontSize="lg" color="brand.200" fontWeight="semibold">
              {redeemDisplaySymbol}
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
          <Box bg="rgba(20, 18, 14, 0.9)" rounded="xl" p={5} border="1px solid rgba(245,178,27,0.18)">
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
                      colorScheme="brand"
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
                    <HStack spacing={3} align="center">
                    <Input value={unwrapAdvanced.noteId} onChange={handleUnwrapAdvancedChange('noteId')} />
                      <Button size="sm" variant="outline" onClick={() => void handlePreviewNullifier()}>
                        Derive nullifier
                      </Button>
                    </HStack>
                    {nullifierPreview && (
                      <FormHelperText color="whiteAlpha.500">Derived nullifier: {nullifierPreview}</FormHelperText>
                    )}
                    {nullifierPreviewError && <FormHelperText color="red.300">{nullifierPreviewError}</FormHelperText>}
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Spending key</FormLabel>
                    <Input value={unwrapAdvanced.spendingKey} onChange={handleUnwrapAdvancedChange('spendingKey')} />
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Note amount</FormLabel>
                    <HStack spacing={3} align="center">
                      <Input
                        value={unwrapAdvanced.noteAmount}
                        onChange={handleUnwrapAdvancedChange('noteAmount')}
                        placeholder="Defaults to amount + fee"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setUnwrapAdvanced((prev) => ({
                            ...prev,
                            noteAmount: (() => {
                              try {
                                const baseAmount = amount ? BigInt(amount) : 0n;
                                const feeAmount = prev.exitFee ? BigInt(prev.exitFee) : 0n;
                                return (baseAmount + feeAmount).toString();
                              } catch {
                                return prev.noteAmount;
                              }
                            })()
                          }))
                        }
                      >
                        Use amount + fee
                      </Button>
                    </HStack>
                    <FormHelperText color="whiteAlpha.500">
                      Provide the total note value in base units. Leave blank to assume the exact exit amount.
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Saved notes</FormLabel>
                    <HStack spacing={3} align="start">
                      <Select
                        value={selectedStoredNoteId ?? ''}
                        onChange={(event) => handleSelectStoredNote(event.target.value)}
                        placeholder={storedNotes.length ? 'Select a saved note' : 'No notes saved yet'}
                      >
                        {storedNotes.map((note) => (
                          <option key={note.id} value={note.id}>
                            {note.label}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={!selectedStoredNoteId}
                        onClick={() => selectedStoredNoteId && handleRemoveStoredNote(selectedStoredNoteId)}
                      >
                        Remove
                      </Button>
                    </HStack>
                    <FormHelperText color="whiteAlpha.500">
                      Notes are stored locally in your browser for quick selection.
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Label &amp; save current note</FormLabel>
                    <HStack spacing={3} align="center">
                      <Input
                        value={noteLabelDraft}
                        onChange={(event) => setNoteLabelDraft(event.target.value)}
                        placeholder="Alias for this note"
                      />
                      <Button size="sm" variant="outline" onClick={handleSaveStoredNote}>
                        Save note
                      </Button>
                    </HStack>
                    <FormHelperText color="whiteAlpha.500">
                      Saves the note id, spending key, amount, and optional change recipient to local storage.
                    </FormHelperText>
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
                      <Box mt={3} bg="rgba(20, 18, 14, 0.82)" p={3} rounded="md" border="1px solid rgba(245,178,27,0.12)">
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
                    <FormLabel htmlFor="autoChange" mb="0" color="whiteAlpha.700">
                      Auto-compute change output
                    </FormLabel>
                    <Switch
                      id="autoChange"
                      colorScheme="teal"
                      isChecked={unwrapAdvanced.autoChange}
                      onChange={handleUnwrapAdvancedChange('autoChange')}
                    />
                  </FormControl>
                  <FormControl isDisabled={unwrapAdvanced.autoChange}>
                    <FormLabel color="whiteAlpha.700">Change amount</FormLabel>
                    <Input
                      value={unwrapAdvanced.autoChange ? computedChangeAmount?.toString() ?? '' : unwrapAdvanced.changeAmount}
                      onChange={handleUnwrapAdvancedChange('changeAmount')}
                      placeholder="Defaults to note amount - amount - fee"
                    />
                    <FormHelperText color={computedChangeAmount !== null && computedChangeAmount < 0n ? 'red.300' : 'whiteAlpha.500'}>
                      {computedChangeAmount === null
                        ? 'Enter numeric values to preview change.'
                        : `Current change preview: ${computedChangeAmount.toString()}`}
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Change recipient (field element)</FormLabel>
                    <Input
                      value={unwrapAdvanced.changeRecipient}
                      onChange={handleUnwrapAdvancedChange('changeRecipient')}
                      placeholder="Required when change > 0"
                    />
                    <FormHelperText color="whiteAlpha.500">
                      Provide the field representation of the private recipient for leftover funds.
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel color="whiteAlpha.700">Change blindings</FormLabel>
                    <HStack spacing={3} align="center">
                      <Input
                        value={unwrapAdvanced.changeBlinding}
                        onChange={handleUnwrapAdvancedChange('changeBlinding')}
                        placeholder="Commitment blinding"
                      />
                      <Input
                        value={unwrapAdvanced.changeAmountBlinding}
                        onChange={handleUnwrapAdvancedChange('changeAmountBlinding')}
                        placeholder="Amount blinding"
                      />
                      <Button size="sm" variant="outline" onClick={handleGenerateBlindings}>
                        Generate
                      </Button>
                    </HStack>
                    <FormHelperText color="whiteAlpha.500">
                      Leave blank to auto-generate secure blindings when submitting.
                    </FormHelperText>
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
        <Box bg="rgba(20, 18, 14, 0.9)" rounded="xl" p={4} border="1px solid rgba(245,178,27,0.18)" fontFamily="mono">
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

