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
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { MINTS, MintConfig } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import { wrap as wrapSdk, unwrap as unwrapSdk, resolvePublicKey } from '../../lib/sdk';
import { IndexerClient, IndexerNote } from '../../lib/indexerClient';
import { getCachedRoots, setCachedRoots, getCachedNullifiers, setCachedNullifiers } from '../../lib/indexerCache';
import { poseidonHashMany } from '../../lib/onchain/poseidon';
import { formatBaseUnitsToUi } from '../../lib/format';

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

interface TokenOption {
  originMint: string;
  variant: 'public' | 'private';
  label: string;
  balance: bigint;
  displayBalance: string;
  symbol: string;
  decimals: number;
  disabled: boolean;
  zTokenMint?: string;
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

const AMOUNT_INPUT_PATTERN = /^\d*(?:\.\d*)?$/;

function normaliseAmountInput(value: string): string {
  let trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('.')) {
    trimmed = `0${trimmed}`;
  }
  if (trimmed.endsWith('.')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function parseUiAmountToBaseUnits(value: string, decimals: number, label = 'amount'): bigint {
  const normalised = normaliseAmountInput(value);
  if (!normalised) {
    throw new Error(`Enter an ${label}.`);
  }
  if (!AMOUNT_INPUT_PATTERN.test(normalised)) {
    throw new Error(`Invalid ${label}. Use a numeric value with up to ${decimals} decimal places.`);
  }
  const [wholePartRaw, fractionRaw = ''] = normalised.split('.');
  if (fractionRaw.length > decimals) {
    throw new Error(`Invalid ${label}. Maximum ${decimals} decimal places allowed.`);
  }
  const wholePart = wholePartRaw || '0';
  if (decimals === 0) {
    return BigInt(wholePart);
  }
  const fractionPart = fractionRaw.padEnd(decimals, '0');
  const combined = `${wholePart}${fractionPart}`.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(combined);
}

function parseOptionalUiAmountToBaseUnits(value: string, decimals: number, label = 'amount'): bigint {
  const normalised = normaliseAmountInput(value);
  if (!normalised) {
    return 0n;
  }
  if (!AMOUNT_INPUT_PATTERN.test(normalised)) {
    throw new Error(`Invalid ${label}. Use a numeric value with up to ${decimals} decimal places.`);
  }
  return parseUiAmountToBaseUnits(normalised, decimals, label);
}

export function ConvertForm() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [mode, setMode] = useState<ConvertMode>('to-private');
  const defaultOriginMint = MINTS[0]?.originMint ?? '';
  const [tokenSelection, setTokenSelection] = useState<{ originMint: string; variant: 'public' | 'private' }>({
    originMint: defaultOriginMint,
    variant: 'public'
  });
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

  const [tokenOptions, setTokenOptions] = useState<TokenOption[]>([]);
  const originMint = tokenSelection.originMint;
  const tokenVariant = tokenSelection.variant;

  const mintConfig = useMemo<MintConfig | undefined>(
    () => MINTS.find((mint) => mint.originMint === originMint),
    [originMint]
  );

  const zTokenSymbol = useMemo(() => `z${mintConfig?.symbol ?? 'TOKEN'}`, [mintConfig?.symbol]);
  const redeemDisplaySymbol = useMemo(
    () => (mode === 'to-private' ? zTokenSymbol : mintConfig?.symbol ?? 'TOKEN'),
    [mode, zTokenSymbol, mintConfig?.symbol]
  );

  const proofClient = useMemo(() => new ProofClient(), []);
  const indexerClient = useMemo(() => new IndexerClient(), []);
  const mountedRef = useRef(true);

  const refreshTokenOptions = useCallback(async () => {
    const walletKey = wallet.publicKey;

    const buildOptions = (publicBalances: Map<string, bigint>, privateBalances: Map<string, bigint>) => {
      const walletConnected = Boolean(walletKey);
      const options: TokenOption[] = [];
      MINTS.forEach((mint) => {
        const publicBalance = publicBalances.get(mint.originMint) ?? 0n;
        const publicDisplay = formatBaseUnitsToUi(publicBalance, mint.decimals);
        options.push({
          originMint: mint.originMint,
          variant: 'public',
          label: `${mint.symbol} (public) — ${publicDisplay}`,
          balance: publicBalance,
          displayBalance: publicDisplay,
          symbol: mint.symbol,
          decimals: mint.decimals,
          disabled: !walletConnected || publicBalance === 0n,
          zTokenMint: mint.zTokenMint
        });
        if (mint.zTokenMint) {
          const privateBalance = privateBalances.get(mint.zTokenMint) ?? 0n;
          const privateDisplay = formatBaseUnitsToUi(privateBalance, mint.decimals);
          options.push({
            originMint: mint.originMint,
            variant: 'private',
            label: `z${mint.symbol} (private) — ${privateDisplay}`,
            balance: privateBalance,
            displayBalance: privateDisplay,
            symbol: `z${mint.symbol}`,
            decimals: mint.decimals,
            disabled: !walletConnected || privateBalance === 0n,
            zTokenMint: mint.zTokenMint
          });
        }
      });
      return options;
    };

    if (!walletKey) {
      const options = buildOptions(new Map(), new Map());
      setTokenOptions(options);
      return options;
    }

    try {
      const [legacyAccounts, token2022Accounts] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(walletKey, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(walletKey, { programId: TOKEN_2022_PROGRAM_ID })
      ]);

      const publicBalances = new Map<string, bigint>();
      const accumulateBalance = (account: typeof legacyAccounts.value[number]) => {
        const parsedInfo = account.account.data?.parsed?.info;
        const mintAddress: string | undefined = parsedInfo?.mint ?? parsedInfo?.tokenAmount?.mint;
        const amountStr: string | undefined = parsedInfo?.tokenAmount?.amount;
        if (!mintAddress || typeof amountStr !== 'string') {
          return;
        }
        let amount = 0n;
        try {
          amount = BigInt(amountStr);
        } catch {
          amount = 0n;
        }
        if (amount === 0n) {
          return;
        }
        const current = publicBalances.get(mintAddress) ?? 0n;
        publicBalances.set(mintAddress, current + amount);
      };

      legacyAccounts.value.forEach(accumulateBalance);
      token2022Accounts.value.forEach(accumulateBalance);

      const privateBalances = new Map<string, bigint>();
      try {
        const privateResult = await indexerClient.getBalances(walletKey.toBase58());
        if (privateResult?.balances) {
          Object.entries(privateResult.balances).forEach(([mint, value]) => {
            try {
              privateBalances.set(mint, BigInt(value));
            } catch {
              privateBalances.set(mint, 0n);
            }
          });
        }
      } catch (error) {
        console.warn('[convert-form] failed to fetch private balances', error);
      }

      const options = buildOptions(publicBalances, privateBalances);
      setTokenOptions(options);
      return options;
    } catch (error) {
      console.warn('[convert-form] failed to fetch token balances', error);
      const options = buildOptions(new Map(), new Map());
      setTokenOptions(options);
      return options;
    }
  }, [wallet.publicKey, connection, indexerClient]);

  useEffect(() => {
    void refreshTokenOptions();
  }, [refreshTokenOptions]);

  const allowedVariant: 'public' | 'private' = mode === 'to-private' ? 'public' : 'private';
  const filteredTokenOptions = useMemo(
    () => tokenOptions.filter((option) => option.variant === allowedVariant),
    [tokenOptions, allowedVariant]
  );
  const tokenSelectValue =
    filteredTokenOptions.length > 0 ? `${tokenVariant}:${originMint}` : '__none';
  const selectedTokenOption = useMemo(
    () => tokenOptions.find((option) => option.originMint === originMint && option.variant === tokenVariant) ?? null,
    [tokenOptions, originMint, tokenVariant]
  );

  useEffect(() => {
    if (!tokenOptions.length) {
      return;
    }
    const desiredVariant: 'public' | 'private' = mode === 'to-private' ? 'public' : 'private';
    const candidates = tokenOptions.filter((option) => option.variant === desiredVariant);
    if (!candidates.length) {
      return;
    }
    const hasCurrent = candidates.some((option) => option.originMint === originMint);
    if (tokenVariant !== desiredVariant || !hasCurrent) {
      const nextOption = hasCurrent
        ? candidates.find((option) => option.originMint === originMint)!
        : candidates[0];
      setTokenSelection({
        originMint: nextOption.originMint,
        variant: desiredVariant
      });
    }
  }, [mode, tokenOptions, originMint, tokenVariant]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
        void (async () => {
          try {
            const chainRoots = await indexerClient.getRoots(originMint, { source: 'chain' });
            if (chainRoots) {
              const chainCurrent = normaliseField(chainRoots.current);
              const chainRecent = chainRoots.recent.map(normaliseField);
              if (chainCurrent && chainCurrent.toLowerCase() !== parsed.current.toLowerCase()) {
                if (mountedRef.current) {
                  setRoots({
                    current: chainCurrent,
                    recent: chainRecent,
                    source: `${parsed.source}+chain`
                  });
                  setCachedRoots({
                    mint: originMint,
                    current: chainCurrent,
                    recent: chainRecent,
                    source: `${parsed.source}+chain`
                  });
                }
                await indexerClient.publishRoots(originMint, chainCurrent, chainRecent);
              } else if (!parsed.recent.length && chainRecent.length && mountedRef.current) {
                setRoots({
                  current: parsed.current,
                  recent: chainRecent,
                  source: parsed.source
                });
                setCachedRoots({
                  mint: originMint,
                  current: parsed.current,
                  recent: chainRecent,
                  source: parsed.source
                });
              }
            }
          } catch (publishError) {
            // eslint-disable-next-line no-console
            console.warn('[roots] failed to reconcile indexer roots with chain', publishError);
          }
        })();
        return parsed;
      }
      throw new Error('Unable to resolve commitment tree root from indexer');
    } catch (caught) {
      try {
        const fallback = await indexerClient.getRoots(originMint, { source: 'chain' });
        if (fallback && mountedRef.current) {
          const chainCurrent = normaliseField(fallback.current);
          const chainRecent = fallback.recent.map(normaliseField);
          const nextState = {
            current: chainCurrent,
            recent: chainRecent,
            source: fallback.source ?? 'chain'
          };
          setRoots(nextState);
          setCachedRoots({
            mint: originMint,
            current: nextState.current,
            recent: nextState.recent,
            source: nextState.source
          });
        }
        void (async () => {
          try {
            if (fallback) {
              await indexerClient.publishRoots(originMint, fallback.current, fallback.recent);
            }
          } catch (publishError) {
            // eslint-disable-next-line no-console
            console.warn('[roots] failed to publish fallback roots to indexer', publishError);
          }
        })();
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
  }, [indexerClient, originMint]);

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
    if (!mintConfig) {
      return null;
    }
    const decimals = mintConfig.decimals;
    try {
      const baseAmount = parseOptionalUiAmountToBaseUnits(amount, decimals);
      const feeAmount = parseOptionalUiAmountToBaseUnits(unwrapAdvanced.exitFee, decimals);
      const totalOut = baseAmount + feeAmount;
      if (unwrapAdvanced.autoChange) {
        const noteTotal = unwrapAdvanced.noteAmount
          ? parseUiAmountToBaseUnits(unwrapAdvanced.noteAmount, decimals, 'note amount')
          : totalOut;
        return noteTotal - totalOut;
      }
      return unwrapAdvanced.changeAmount
        ? parseUiAmountToBaseUnits(unwrapAdvanced.changeAmount, decimals, 'change amount')
        : 0n;
    } catch {
      return null;
    }
  }, [
    amount,
    mintConfig,
    unwrapAdvanced.autoChange,
    unwrapAdvanced.changeAmount,
    unwrapAdvanced.exitFee,
    unwrapAdvanced.noteAmount
  ]);

  const changePreviewDisplay = useMemo(() => {
    if (computedChangeAmount === null || !mintConfig) {
      return null;
    }
    return formatBaseUnitsToUi(computedChangeAmount, mintConfig.decimals);
  }, [computedChangeAmount, mintConfig]);

  const handleModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMode = event.target.value as ConvertMode;
    setMode(nextMode);
    setResult(null);
    setProofPreview(null);
    setError(null);
    setSelectedStoredNoteId(null);
    setNoteLabelDraft('');
    setNullifierPreview(null);
    setNullifierPreviewError(null);
    setTokenSelection((prev) => ({
      originMint: prev.originMint,
      variant: nextMode === 'to-private' ? 'public' : 'private'
    }));
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
      if (!selectedTokenOption) {
        throw new Error('Select a token before converting.');
      }

      const poolId = mintConfig.poolId;
      const mintId = mintConfig.originMint;

      let rootValue = resolvedOldRoot;
      const latestRoots = await refreshRoots();
      if (latestRoots?.current) {
        rootValue = latestRoots.current;
      }

      if (!rootValue) {
        throw new Error('Unable to resolve the current commitment tree root. Refresh and try again.');
      }

      const decimals = mintConfig.decimals;

      if (mode === 'to-private') {
        if (tokenVariant !== 'public') {
          throw new Error('Select a public token to shield.');
        }
        const baseAmount = parseUiAmountToBaseUnits(amount, decimals, 'amount');
        if (baseAmount <= 0n) {
          throw new Error('Amount must be greater than zero.');
        }
        if (selectedTokenOption && selectedTokenOption.balance < baseAmount) {
          throw new Error(`Insufficient ${selectedTokenOption.symbol} balance.`);
        }
        const payload = {
          oldRoot: rootValue,
          amount: baseAmount.toString(),
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

        const signature = await wrapSdk({
          connection,
          wallet,
          originMint,
          amount: baseAmount,
          poolId,
          depositId: wrapAdvanced.depositId,
          blinding: wrapAdvanced.blinding,
          proof: wrapAdvanced.useProofRpc ? proofResponse : null,
          commitmentHint: proofResponse?.publicInputs?.[2] ?? null,
          recipient: wallet.publicKey.toBase58(),
          twinMint: mintConfig.zTokenMint ?? null
        });

        try {
          await indexerClient.adjustBalance(
            wallet.publicKey.toBase58(),
            mintConfig.zTokenMint ?? originMint,
            baseAmount
          );
        } catch (error) {
          console.warn('Failed to adjust private balance', error);
        }
        const displayAmount = formatBaseUnitsToUi(baseAmount, decimals);
        setResult(`Shielded ${displayAmount} into ${zTokenSymbol}. Signature: ${signature}`);
        await refreshTokenOptions();
      } else {
        if (tokenVariant !== 'private') {
          throw new Error('Select a private token to redeem.');
        }
        if (!mintConfig.zTokenMint) {
          throw new Error('This token does not support private redemptions.');
        }
        const destinationKey = await resolvePublicKey(unwrapAdvanced.destination, wallet.publicKey);

        const amountValue = parseUiAmountToBaseUnits(amount, decimals, 'amount');
        if (amountValue <= 0n) {
          throw new Error('Amount must be greater than zero.');
        }
        const feeValue = parseOptionalUiAmountToBaseUnits(unwrapAdvanced.exitFee, decimals, 'exit fee');
        let noteAmountValue = unwrapAdvanced.noteAmount
          ? parseUiAmountToBaseUnits(unwrapAdvanced.noteAmount, decimals, 'note amount')
          : amountValue + feeValue;

        const totalOutflow = amountValue + feeValue;
        if (noteAmountValue < totalOutflow) {
          throw new Error('Note amount must cover the requested amount plus exit fee.');
        }
        if (selectedTokenOption && selectedTokenOption.balance < totalOutflow) {
          throw new Error(`Insufficient ${selectedTokenOption.symbol} balance.`);
        }

        let changeAmountValue: bigint;
        if (unwrapAdvanced.autoChange) {
          changeAmountValue = noteAmountValue - totalOutflow;
        } else if (unwrapAdvanced.changeAmount) {
          changeAmountValue = parseUiAmountToBaseUnits(unwrapAdvanced.changeAmount, decimals, 'change amount');
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
          mode: 'origin',
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

        const privateMint = mintConfig.zTokenMint;

        const unwrapParams = {
          connection,
          wallet,
          originMint,
          amount: amountValue,
          poolId,
          destination: destinationKey.toBase58(),
          mode: 'origin',
          proof: proofResponse,
          lookupTable: mintConfig.lookupTable,
          twinMint: mintConfig.zTokenMint
        } as {
          connection: typeof connection;
          wallet: typeof wallet;
          originMint: string;
          amount: bigint;
          poolId: string;
          destination: string;
          mode: 'origin';
          proof: ProofResponse;
          lookupTable?: string;
          twinMint?: string;
        };

        if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
          // eslint-disable-next-line no-console
          console.info('[convert] unwrap params', unwrapParams);
        }

        await unwrapSdk(unwrapParams);

        try {
          await indexerClient.adjustBalance(wallet.publicKey.toBase58(), privateMint, -amountValue);
        } catch (error) {
          console.warn('Failed to decrement private balance', error);
        }
        if (changeAmountValue > 0n) {
          try {
            await indexerClient.adjustBalance(
              wallet.publicKey.toBase58(),
              privateMint,
              changeAmountValue
            );
          } catch (error) {
            console.warn('Failed to increment change balance', error);
          }
        }

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

        const displayAmount = formatBaseUnitsToUi(amountValue, decimals);
        const targetSymbol = mintConfig?.symbol ?? 'TOKEN';
        setResult(`Redeemed ${displayAmount} ${targetSymbol}.`);
        await refreshTokenOptions();
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
          <Select
            value={tokenSelectValue}
            onChange={(event) => {
              const { value } = event.target;
              if (value === '__none') {
                return;
              }
              const [variant, mint] = value.split(':');
              setTokenSelection({
                originMint: mint,
                variant: variant === 'private' ? 'private' : 'public'
              });
            }}
            bg="rgba(18, 16, 14, 0.78)"
          >
            {filteredTokenOptions.length > 0 ? (
              filteredTokenOptions.map((option) => (
                <option
                  key={`${option.variant}:${option.originMint}`}
                  value={`${option.variant}:${option.originMint}`}
                  disabled={option.disabled}
                >
                  {option.label}
                </option>
              ))
            ) : (
              <option value="__none" disabled>
                No tokens available
              </option>
            )}
          </Select>
          <FormHelperText color="whiteAlpha.500">
            {mode === 'to-private'
              ? `Private balance will appear as ${zTokenSymbol}.`
              : `Public balance will appear as ${mintConfig?.symbol ?? 'TOKEN'}.`}
          </FormHelperText>
          {selectedTokenOption && (
            <FormHelperText color="whiteAlpha.500">
              Available: {selectedTokenOption.displayBalance} {selectedTokenOption.symbol}
            </FormHelperText>
          )}
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
          <FormLabel color="whiteAlpha.700">Amount</FormLabel>
          <NumberInput
            min={0}
            value={amount}
            onChange={(valueString) => setAmount(valueString)}
            precision={mintConfig?.decimals ?? 0}
            clampValueOnBlur={false}
          >
            <NumberInputField placeholder="0" inputMode="decimal" />
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
                    <FormLabel color="whiteAlpha.700">Exit fee</FormLabel>
                    <Input
                      value={unwrapAdvanced.exitFee}
                      onChange={handleUnwrapAdvancedChange('exitFee')}
                      inputMode="decimal"
                      placeholder="0"
                    />
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
                        inputMode="decimal"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setUnwrapAdvanced((prev) => ({
                            ...prev,
                            noteAmount: (() => {
                              if (!mintConfig) {
                                return prev.noteAmount;
                              }
                              try {
                                const decimals = mintConfig.decimals;
                                const baseAmount = parseOptionalUiAmountToBaseUnits(amount, decimals);
                                const feeAmount = parseOptionalUiAmountToBaseUnits(prev.exitFee, decimals, 'exit fee');
                                const total = baseAmount + feeAmount;
                                return formatBaseUnitsToUi(total, decimals);
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
                      Provide the total note value in tokens. Leave blank to assume the exact exit amount.
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
                      value={unwrapAdvanced.autoChange ? changePreviewDisplay ?? '' : unwrapAdvanced.changeAmount}
                      onChange={handleUnwrapAdvancedChange('changeAmount')}
                      placeholder="Defaults to note amount - amount - fee"
                      inputMode="decimal"
                    />
                    <FormHelperText color={computedChangeAmount !== null && computedChangeAmount < 0n ? 'red.300' : 'whiteAlpha.500'}>
                      {computedChangeAmount === null
                        ? 'Enter numeric values to preview change.'
                        : `Current change preview: ${changePreviewDisplay}`}
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

