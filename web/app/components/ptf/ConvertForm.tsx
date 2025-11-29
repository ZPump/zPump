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
  HStack,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  InputRightElement,
  NumberInput,
  NumberInputField,
  Select,
  Stack,
  Text,
  Tooltip,
  useBoolean,
  VStack
} from '@chakra-ui/react';
import { X } from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMint
} from '@solana/spl-token';
import { LAMPORTS_PER_SOL, PublicKey, SendTransactionError } from '@solana/web3.js';
import type { MintConfig } from '../../config/mints';
import { ProofClient, ProofResponse } from '../../lib/proofClient';
import {
  wrap as wrapSdk,
  unwrap as unwrapSdk,
  preparePool,
  resolvePublicKey,
  fetchMintMappingAccount,
  getTokenMetadata,
  MINT_STATUS
} from '../../lib/sdk';
import { IndexerClient, IndexerNote } from '../../lib/indexerClient';
import { getCachedRoots, setCachedRoots, getCachedNullifiers, setCachedNullifiers } from '../../lib/indexerCache';
import { poseidonHashMany } from '../../lib/onchain/poseidon';
import { derivePoolState, deriveCommitmentTree, deriveTokenMetadata } from '../../lib/onchain/pdas';
import { FACTORY_PROGRAM_ID } from '../../lib/onchain/programIds';
import factoryIdl from '../../idl/ptf_factory.json';
import { BorshCoder } from '@coral-xyz/anchor';
import { decodeCommitmentTree } from '../../lib/onchain/commitmentTree';
import { bytesLEToCanonicalHex } from '../../lib/onchain/utils';
import type { StoredNoteRecord } from '../../lib/notes/storage';
import { readStoredNotes, writeStoredNotes } from '../../lib/notes/storage';
import { formatBaseUnitsToUi } from '../../lib/format';
import { useMintCatalog } from '../providers/MintCatalogProvider';
import { recordWalletActivity } from '../../lib/client/activityLog';
import { useLocalWallet } from '../wallet/LocalWalletContext';
import { normalizeError } from '../../lib/errorHandler';

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
  name?: string;
  image?: string;
  decimals: number;
  disabled: boolean;
  zTokenMint?: string;
  isFrozen: boolean;
  isOwned: boolean;
}

const createRandomSeed = () => Math.floor(Math.random() * 1_000_000).toString();

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

function normaliseSendError(error: unknown): string {
  return normalizeError(error);
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
  const { viewingId } = useLocalWallet();
  const { mints, loading: mintCatalogLoading, error: mintCatalogError } = useMintCatalog();

  const [mode, setMode] = useState<ConvertMode>('to-private');
  const [tokenSelection, setTokenSelection] = useState<{ originMint: string; variant: 'public' | 'private' }>({
    originMint: '',
    variant: 'public'
  });
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [amount, setAmount] = useState<string>('1');
  const [isSubmitting, setSubmitting] = useBoolean(false);
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
  const [storedNotes, setStoredNotes] = useState<StoredNoteRecord[]>(() => readStoredNotes());
  const [selectedStoredNoteId, setSelectedStoredNoteId] = useState<string | null>(null);
  const [noteLabelDraft, setNoteLabelDraft] = useState<string>('');
  const [nullifierPreview, setNullifierPreview] = useState<string | null>(null);
  const [nullifierPreviewError, setNullifierPreviewError] = useState<string | null>(null);
  const [mintStatuses, setMintStatuses] = useState<Record<string, number>>({});
  const [mintStatusLoading, setMintStatusLoading] = useState(false);
  const [mintStatusError, setMintStatusError] = useState<string | null>(null);

  const [tokenOptions, setTokenOptions] = useState<TokenOption[]>([]);
  const [tokenSearchQuery, setTokenSearchQuery] = useState<string>('');
  const [isTokenDropdownOpen, setIsTokenDropdownOpen] = useState(false);
  const [pastedMint, setPastedMint] = useState<string>('');
  const [pastedMintLoading, setPastedMintLoading] = useState(false);
  const [pastedMintError, setPastedMintError] = useState<string | null>(null);
  const [customMints, setCustomMints] = useState<Map<string, { symbol: string; decimals: number; name?: string; image?: string }>>(new Map());
  const [tokenMetadataMap, setTokenMetadataMap] = useState<Record<string, { name: string; symbol: string; image?: string }>>(() => {
    // Load cached metadata from localStorage on mount
    if (typeof window !== 'undefined') {
      try {
        const { loadCachedMetadata } = require('../../lib/tokenMetadata/storage');
        const cached = loadCachedMetadata();
        console.debug('[convert-form] Loaded cached metadata on mount', { 
          count: Object.keys(cached).length,
          mints: Object.keys(cached),
          metadata: cached
        });
        return cached;
      } catch (error) {
        console.warn('[convert-form] Failed to load cached metadata:', error);
      }
    }
    return {};
  });
  const [selectedTokenDisplayText, setSelectedTokenDisplayText] = useState<string>('');
  const originMint = tokenSelection.originMint;
  const tokenVariant = tokenSelection.variant;

  // Debug logging
  useEffect(() => {
    console.log('🔍 TOKEN SELECTION STATE:', { originMint, tokenVariant, isTokenDropdownOpen, shouldShowBadge: originMint && !isTokenDropdownOpen });
  }, [originMint, tokenVariant, isTokenDropdownOpen]);

  // Force close dropdown when token is selected
  useEffect(() => {
    if (originMint) {
      setIsTokenDropdownOpen(false);
    }
  }, [originMint]);

  const mintConfig = useMemo<MintConfig | undefined>(() => {
    // First try to find in catalog by originMint
    const catalogMint = mints.find((mint) => mint.originMint === originMint);
    if (catalogMint) {
      return catalogMint;
    }
    // If not found and we have a private token selected, try to find it in tokenOptions
    if (tokenSelection.variant === 'private' && originMint) {
      const privateOption = tokenOptions.find(
        (opt) => opt.originMint === originMint && opt.variant === 'private' && opt.zTokenMint
      );
      if (privateOption?.zTokenMint) {
        return {
          originMint,
          poolId: derivePoolState(new PublicKey(originMint)).toBase58(),
          symbol: privateOption.symbol.replace(/^z/, ''),
          decimals: privateOption.decimals,
          zTokenMint: privateOption.zTokenMint,
          features: {
            zTokenEnabled: true,
            wrappedTransfers: false
          }
        };
      }
    }
    return undefined;
  }, [mints, originMint, tokenSelection.variant, tokenOptions]);

  const decimals = mintConfig?.decimals ?? 0;

  const proofClient = useMemo(() => new ProofClient(), []);
  const indexerClient = useMemo(() => new IndexerClient(), []);
  const mountedRef = useRef(true);
  const selectingTokenRef = useRef(false);

  const requestAutoSolAirdrop = useCallback(async () => {
    if (!wallet.publicKey) {
      throw new Error('Connect your wallet before requesting SOL.');
    }
    const response = await fetch('/api/faucet/sol', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: wallet.publicKey.toBase58() })
    });
    if (!response.ok) {
      let errorText: string | null = null;
      try {
        const payload = (await response.json()) as { error?: string };
        errorText = payload.error ?? null;
      } catch {
        errorText = await response.text().catch(() => null);
      }
      throw new Error(
        `Unable to automatically fund SOL for unwrap. ${
          errorText ?? response.statusText ?? 'Use the Faucet tab to airdrop SOL, then retry.'
        }`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, [wallet.publicKey]);

  const ensureWalletFeeBalance = useCallback(async () => {
    if (!wallet.publicKey) {
      return;
    }
    const MIN_FEE_BALANCE = 0.02 * LAMPORTS_PER_SOL;
    let balance = await connection.getBalance(wallet.publicKey);
    if (balance >= MIN_FEE_BALANCE) {
      return;
    }
    await requestAutoSolAirdrop();
    balance = await connection.getBalance(wallet.publicKey);
    if (balance < MIN_FEE_BALANCE) {
      throw new Error('Unable to fund SOL for transaction fees. Use the Faucet tab to airdrop SOL, then retry.');
    }
  }, [wallet.publicKey, connection, requestAutoSolAirdrop]);

  const ensureDestinationAccountFunding = useCallback(
    async ({
      owner,
      mint,
      tokenProgram
    }: {
      owner: PublicKey;
      mint: string;
      tokenProgram: PublicKey;
    }) => {
      if (!wallet.publicKey) {
        return;
      }
      const destinationMintKey = new PublicKey(mint);
      const destinationAta = await getAssociatedTokenAddress(
        destinationMintKey,
        owner,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const destinationInfo = await connection.getAccountInfo(destinationAta);
      if (destinationInfo) {
        return;
      }
      const rentLamports = await connection.getMinimumBalanceForRentExemption(AccountLayout.span);
      const MIN_FEE_BUFFER = 150_000;
      const requiredLamports = rentLamports + MIN_FEE_BUFFER;
      let currentBalance = await connection.getBalance(wallet.publicKey);
      if (currentBalance >= requiredLamports) {
        return;
      }
      await requestAutoSolAirdrop();
      currentBalance = await connection.getBalance(wallet.publicKey);
      if (currentBalance < requiredLamports) {
        throw new Error('Insufficient SOL to create the destination token account. Use the Faucet tab, then retry.');
      }
    },
    [wallet.publicKey, connection, requestAutoSolAirdrop]
  );

  // Throttle token account fetching to max once every 10 seconds
  const lastTokenFetchRef = useRef<number>(0);
  const TOKEN_FETCH_THROTTLE_MS = 10_000;

  const refreshTokenOptions = useCallback(async () => {
    const now = Date.now();
    const timeSinceLastFetch = now - lastTokenFetchRef.current;
    
    // If called too soon, skip the actual fetch but still update options with cached data
    // BUT: if tokenOptions is empty, always fetch (first load)
    // Also allow fetch if wallet just connected (wallet.publicKey changed)
    const shouldThrottle = timeSinceLastFetch < TOKEN_FETCH_THROTTLE_MS && tokenOptions.length > 0;
    if (shouldThrottle) {
      console.debug('[convert-form] Throttling token account fetch', { timeSinceLastFetch, throttleMs: TOKEN_FETCH_THROTTLE_MS, cachedOptionsCount: tokenOptions.length });
      // Return cached options without fetching
      return tokenOptions;
    }
    
    lastTokenFetchRef.current = now;
    
    const walletKey = wallet.publicKey;

    if (!mints.length) {
      setTokenOptions([]);
      return [];
    }

    // Get current tokenMetadataMap state to use in buildOptions
    const currentMetadataMap = tokenMetadataMap;
    console.debug('[convert-form] refreshTokenOptions - currentMetadataMap', {
      count: Object.keys(currentMetadataMap).length,
      mints: Object.keys(currentMetadataMap),
      sample: Object.entries(currentMetadataMap).slice(0, 3).map(([mint, meta]) => ({ mint, meta }))
    });
    
    const buildOptions = async (publicBalances: Map<string, bigint>, privateBalances: Map<string, bigint>, mintsToUse: Map<string, { symbol: string; decimals: number; name?: string; image?: string }> = customMints, metadataMap: Record<string, { name: string; symbol: string; image?: string }> = currentMetadataMap, zTokenToOriginMap: Map<string, { originMint: string; decimals: number; symbol: string }> = new Map()) => {
      const walletConnected = Boolean(walletKey);
      const options: TokenOption[] = [];
      
      // Add custom mints (pasted mints and auto-detected wallet tokens)
      mintsToUse.forEach((customMint, mintAddress) => {
        const publicBalance = publicBalances.get(mintAddress) ?? 0n;
        const publicDisplay = formatBaseUnitsToUi(publicBalance, customMint.decimals);
        const status = mintStatuses[mintAddress];
        const isMintFrozen = status === MINT_STATUS.FROZEN;
        const freezeSuffix = isMintFrozen ? ' — Frozen by governance' : '';
        const metadata = metadataMap[mintAddress];
        // Use cached metadata if available, otherwise use customMint data
        // Prioritize metadata symbol/name over customMint (which might be truncated address)
        // Only use metadata if it has actual values (not empty strings)
        const symbol = (metadata?.symbol && metadata.symbol.trim()) ? metadata.symbol : customMint.symbol;
        const name = (metadata?.name && metadata.name.trim()) ? metadata.name : (customMint.name || undefined);
        const image = metadata?.image || customMint.image;
        options.push({
          originMint: mintAddress,
          variant: 'public',
          label: `${name || symbol} (${symbol}) — ${publicDisplay}${freezeSuffix}`,
          balance: publicBalance,
          displayBalance: publicDisplay,
          symbol,
          name,
          image,
          decimals: customMint.decimals,
          disabled: !walletConnected || isMintFrozen, // Allow selection even with 0 balance
          zTokenMint: undefined,
          isFrozen: isMintFrozen,
          isOwned: publicBalance > 0n
        });
      });
      
      mints.forEach((mint) => {
        const status = mintStatuses[mint.originMint];
        const isMintFrozen = status === MINT_STATUS.FROZEN;
        const freezeSuffix = isMintFrozen ? ' — Frozen by governance' : '';
        const publicBalance = publicBalances.get(mint.originMint) ?? 0n;
        const publicDisplay = formatBaseUnitsToUi(publicBalance, mint.decimals);
        const metadata = metadataMap[mint.originMint];
        // Use cached metadata if available, otherwise use catalog data
        // Prioritize metadata symbol/name over catalog (catalog might be outdated)
        // Only use metadata if it has actual values (not empty strings)
        const symbol = (metadata?.symbol && metadata.symbol.trim()) ? metadata.symbol : mint.symbol;
        const name = (metadata?.name && metadata.name.trim()) ? metadata.name : undefined;
        const image = metadata?.image;
        options.push({
          originMint: mint.originMint,
          variant: 'public',
          label: `${name || symbol} (${symbol}) — ${publicDisplay}${freezeSuffix}`,
          balance: publicBalance,
          displayBalance: publicDisplay,
          symbol,
          name,
          image,
          decimals: mint.decimals,
          disabled: !walletConnected || isMintFrozen, // Allow selection even with 0 balance
          zTokenMint: mint.zTokenMint,
          isFrozen: isMintFrozen,
          isOwned: publicBalance > 0n
        });
        if (mint.zTokenMint) {
          const privateBalance = privateBalances.get(mint.zTokenMint) ?? 0n;
          const privateDisplay = formatBaseUnitsToUi(privateBalance, mint.decimals);
          // Always create private option, even if balance is 0 (user might want to see available zTokens)
          // But mark as owned only if balance > 0
          const option = {
            originMint: mint.originMint,
            variant: 'private' as const,
            label: `z${metadata?.name || mint.symbol} (z${mint.symbol}) — ${privateDisplay}${freezeSuffix}`,
            balance: privateBalance,
            displayBalance: privateDisplay,
            symbol: `z${mint.symbol}`,
            name: metadata?.name ? `z${metadata.name}` : undefined,
            image: metadata?.image,
            decimals: mint.decimals,
            disabled: !walletConnected || isMintFrozen,
            zTokenMint: mint.zTokenMint,
            isFrozen: isMintFrozen,
            isOwned: privateBalance > 0n
          };
          if (privateBalance > 0n) {
            console.debug('[convert-form] Creating private option with balance', {
              originMint: mint.originMint,
              zTokenMint: mint.zTokenMint,
              symbol: mint.symbol,
              balance: privateBalance.toString(),
              balanceFromMap: privateBalances.has(mint.zTokenMint)
            });
          }
          options.push(option);
        }
      });
      
      // Add private options for zTokens in privateBalances that aren't already in options
      // Private balances are keyed by zToken mint address
      const existingPrivateZTokenMints = new Set(
        options.filter(o => o.variant === 'private' && o.zTokenMint).map(o => o.zTokenMint!)
      );
      
      console.debug('[convert-form] Checking private balances for missing zTokens', {
        totalPrivateBalances: privateBalances.size,
        existingZTokenMints: Array.from(existingPrivateZTokenMints),
        privateBalanceEntries: Array.from(privateBalances.entries()).map(([mint, bal]) => ({ 
          zTokenMint: mint, 
          balance: bal.toString(),
          inExisting: existingPrivateZTokenMints.has(mint)
        }))
      });
      
      for (const [zTokenMint, balance] of privateBalances.entries()) {
        // Skip if already in options or if balance is zero
        if (existingPrivateZTokenMints.has(zTokenMint)) {
          console.debug('[convert-form] Skipping zToken already in options', { zTokenMint, balance: balance.toString() });
          continue;
        }
        if (balance === 0n) continue; // Only show owned tokens
        
        // Find origin mint by checking if any catalog mint has this zTokenMint
        let catalogMint = mints.find(m => m.zTokenMint === zTokenMint);
        let originMint: string | null = null;
        let decimals: number = 9;
        let baseSymbol: string = zTokenMint.slice(0, 8);
        
        if (catalogMint) {
          originMint = catalogMint.originMint;
          decimals = catalogMint.decimals;
          baseSymbol = catalogMint.symbol;
        } else {
          // Not in catalog - check if we have it in the zTokenToOriginMap (looked up earlier)
          const lookup = zTokenToOriginMap.get(zTokenMint);
          if (lookup) {
            originMint = lookup.originMint;
            decimals = lookup.decimals;
            baseSymbol = lookup.symbol;
          } else {
            // Still don't have it - use zToken mint as originMint temporarily
            // This allows the user to see and select the token, even if we don't have full info
            console.debug('[convert-form] zToken not in catalog or lookup map, using zToken mint as originMint', { zTokenMint, balance: balance.toString() });
            originMint = zTokenMint; // Use zToken mint as originMint for now
            // Try to get decimals from chain
            try {
              const mintKey = new PublicKey(zTokenMint);
              try {
                const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_PROGRAM_ID);
                decimals = mintInfo.decimals;
              } catch {
                try {
                  const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_2022_PROGRAM_ID);
                  decimals = mintInfo.decimals;
                } catch {
                  // Keep default 9
                }
              }
            } catch {
              // Keep default 9
            }
            baseSymbol = zTokenMint.slice(0, 8);
          }
        }
        
        if (!originMint) {
          // This shouldn't happen, but handle it
          continue;
        }
        
        console.debug('[convert-form] Adding private option for zToken from privateBalances', {
          zTokenMint,
          originMint,
          symbol: baseSymbol,
          balance: balance.toString()
        });
        const privateDisplay = formatBaseUnitsToUi(balance, decimals);
        const metadata = metadataMap[originMint];
        const symbol = metadata?.symbol || `z${baseSymbol}`;
        const name = metadata?.name ? `z${metadata.name}` : undefined;
        
        options.push({
          originMint,
          variant: 'private',
          label: `${name || symbol} (${symbol}) — ${privateDisplay}`,
          balance,
          displayBalance: privateDisplay,
          symbol,
          name,
          image: metadata?.image,
          decimals,
          disabled: !walletConnected,
          zTokenMint,
          isFrozen: false,
          isOwned: balance > 0n
        });
      }
      
      return options;
    };

    if (!walletKey) {
      const options = await buildOptions(new Map(), new Map(), new Map(), currentMetadataMap, new Map());
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
      
      // Look up origin mints for zTokens not in catalog
      const zTokenToOriginMap = new Map<string, { originMint: string; decimals: number; symbol: string }>();
      const zTokensNotInCatalog = Array.from(privateBalances.keys()).filter(zTokenMint => {
        return privateBalances.get(zTokenMint)! > 0n && !mints.some(m => m.zTokenMint === zTokenMint);
      });
      
      if (zTokensNotInCatalog.length > 0) {
        console.debug('[convert-form] Looking up origin mints for zTokens not in catalog', { count: zTokensNotInCatalog.length });
        try {
          const allMintMappings = await connection.getProgramAccounts(FACTORY_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [{ dataSize: 114 }] // MintMapping size
          });
          
          const factoryCoder = new BorshCoder(factoryIdl as any);
          for (const account of allMintMappings) {
            try {
              const decoded = factoryCoder.accounts.decode('MintMapping', account.account.data) as any;
              const ptknMint = decoded.ptknMint || decoded.ptkn_mint;
              if (ptknMint) {
                const ptknMintStr = new PublicKey(ptknMint).toBase58();
                if (zTokensNotInCatalog.includes(ptknMintStr)) {
                  const originMint = new PublicKey(decoded.originMint || decoded.origin_mint).toBase58();
                  const decimals = decoded.decimals ?? 9;
                  // Try to get symbol from metadata
                  const originMintKey = new PublicKey(originMint);
                  const metadataKey = deriveTokenMetadata(originMintKey);
                  let symbol = originMint.slice(0, 8);
                  try {
                    const metadataInfo = await connection.getAccountInfo(metadataKey, 'confirmed');
                    if (metadataInfo) {
                      const metadata = factoryCoder.accounts.decode('TokenMetadata', metadataInfo.data) as any;
                      symbol = metadata.symbol || symbol;
                    }
                  } catch {
                    // Use default symbol
                  }
                  zTokenToOriginMap.set(ptknMintStr, { originMint, decimals, symbol });
                  console.debug('[convert-form] Found origin mint for zToken', { zTokenMint: ptknMintStr, originMint, symbol });
                }
              }
            } catch {
              continue;
            }
          }
        } catch (error) {
          console.warn('[convert-form] Failed to look up origin mints from MintMapping', { error });
        }
      }

      // Auto-detect tokens from wallet that aren't in catalog
      const catalogMintSet = new Set(mints.map(m => m.originMint));
      const walletMintsToAdd = new Map<string, { decimals: number; symbol: string; name?: string; image?: string }>();
      
      for (const [mintAddress, balance] of publicBalances.entries()) {
        // Skip if already in catalog or custom mints
        if (catalogMintSet.has(mintAddress)) continue;
        if (customMints.has(mintAddress)) continue;
        // Only add if user has a balance (owned tokens)
        if (balance === 0n) continue;
        
        // Check if we already have info cached
        const existingMetadata = tokenMetadataMap[mintAddress];
        const existingCustomMint = customMints.get(mintAddress);
        
        if (existingCustomMint) {
          walletMintsToAdd.set(mintAddress, existingCustomMint);
        } else if (existingMetadata) {
          // Use cached metadata if available
          walletMintsToAdd.set(mintAddress, {
            decimals: 9, // Will be updated when we fetch
            symbol: existingMetadata.symbol,
            name: existingMetadata.name,
            image: existingMetadata.image
          });
        } else {
          // Check if token is in catalog (should have symbol/name there)
          const catalogMint = mints.find(m => m.originMint === mintAddress);
          if (catalogMint) {
            walletMintsToAdd.set(mintAddress, {
              decimals: catalogMint.decimals,
              symbol: catalogMint.symbol,
              name: undefined, // Will be fetched from metadata
              image: undefined
            });
          } else {
            // Will fetch metadata below, for now use defaults
            walletMintsToAdd.set(mintAddress, {
              decimals: 9, // Will be updated when we fetch
              symbol: mintAddress.slice(0, 8),
              name: undefined,
              image: undefined
            });
          }
        }
      }
      
      // Add wallet mints to custom mints if not already there
      const newCustomMints = new Map(customMints);
      walletMintsToAdd.forEach((info, mintAddress) => {
        if (!newCustomMints.has(mintAddress)) {
          newCustomMints.set(mintAddress, info);
        }
      });
      if (newCustomMints.size !== customMints.size) {
        setCustomMints(newCustomMints);
      }

      // Fetch metadata for all unique mints (including newly detected wallet tokens and zTokens)
      const uniqueMints = new Set<string>();
      mints.forEach(m => {
        uniqueMints.add(m.originMint);
        if (m.zTokenMint) uniqueMints.add(m.zTokenMint);
      });
      newCustomMints.forEach((_, mint) => uniqueMints.add(mint));
      // Also add zToken mints from private balances for metadata fetching
      privateBalances.forEach((_, zTokenMint) => uniqueMints.add(zTokenMint));
      
      const metadataPromises = Array.from(uniqueMints).map(async (mintAddress) => {
        try {
          const mintKey = new PublicKey(mintAddress);
          
          // Fetch decimals if not already known (for wallet tokens)
          let decimals: number | undefined;
          const existingCustomMint = newCustomMints.get(mintAddress);
          // Always fetch decimals from chain to ensure accuracy
          try {
            const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_PROGRAM_ID);
            decimals = mintInfo.decimals;
          } catch {
            try {
              const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_2022_PROGRAM_ID);
              decimals = mintInfo.decimals;
            } catch {
              // Keep existing decimals if fetch fails
              decimals = existingCustomMint?.decimals;
            }
          }
          
          // Update customMints with correct decimals if we fetched them
          if (decimals !== undefined && existingCustomMint && existingCustomMint.decimals !== decimals) {
            newCustomMints.set(mintAddress, { ...existingCustomMint, decimals });
          }
          
          const metadata = await getTokenMetadata(connection, mintKey);
          if (metadata) {
            // Update metadata immediately (non-blocking UI update)
            // Preserve existing cached metadata (name/symbol/image) if it exists, only update if chain has better data
            setTokenMetadataMap(prev => {
              const existing = prev[mintAddress];
              return {
                ...prev,
                [mintAddress]: {
                  // Use chain metadata if it has values, otherwise keep cached
                  name: (metadata.name && metadata.name.trim()) ? metadata.name : (existing?.name || ''),
                  symbol: (metadata.symbol && metadata.symbol.trim()) ? metadata.symbol : (existing?.symbol || ''),
                  image: existing?.image // Preserve existing image, will be updated below if IPFS fetch succeeds
                }
              };
            });
            
            // Fetch IPFS image in background (non-blocking)
            let image: string | undefined;
            if (metadata.uri && metadata.uri.startsWith('ipfs://')) {
              const cid = metadata.uri.replace('ipfs://', '');
              image = `https://ipfs.io/ipfs/${cid}`; // Use URI as placeholder
              // Fetch actual image in background
              fetch(`https://ipfs.io/ipfs/${cid}`)
                .then(metadataResponse => {
                  if (metadataResponse.ok) {
                    return metadataResponse.json();
                  }
                  return null;
                })
                .then(metadataJson => {
                  if (metadataJson?.image) {
                    let imageUrl: string;
                    if (metadataJson.image.startsWith('ipfs://')) {
                      const imageCid = metadataJson.image.replace('ipfs://', '');
                      imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
                    } else {
                      imageUrl = metadataJson.image;
                    }
                    // Update metadata map with image when ready (preserve name/symbol from state)
                    setTokenMetadataMap(prev => {
                      const existing = prev[mintAddress];
                      if (!existing) return prev;
                      const updated = { ...existing, image: imageUrl };
                      // Cache updated metadata with image
                      const { saveCachedMetadata } = require('../../lib/tokenMetadata/storage');
                      saveCachedMetadata(mintAddress, updated);
                      return {
                        ...prev,
                        [mintAddress]: updated
                      };
                    });
                  }
                })
                .catch(() => {
                  // Ignore IPFS fetch errors
                });
            } else if (metadata.uri) {
              image = metadata.uri;
              // Update metadata map with image (preserve name/symbol from state)
              setTokenMetadataMap(prev => {
                const existing = prev[mintAddress];
                if (!existing) return prev;
                const updated = { ...existing, image };
                // Cache updated metadata with image
                const { saveCachedMetadata } = require('../../lib/tokenMetadata/storage');
                saveCachedMetadata(mintAddress, updated);
                return {
                  ...prev,
                  [mintAddress]: updated
                };
              });
            }
            
            // Update custom mint with metadata if it exists (only if metadata has values)
            const existing = newCustomMints.get(mintAddress);
            if (existing) {
              setCustomMints(prev => {
                const updated = new Map(prev);
                updated.set(mintAddress, {
                  ...existing,
                  // Only update if metadata has actual values, preserve existing if not
                  symbol: (metadata.symbol && metadata.symbol.trim()) ? metadata.symbol : existing.symbol,
                  name: (metadata.name && metadata.name.trim()) ? metadata.name : existing.name,
                  image: image || existing.image
                });
                return updated;
              });
            }
            
            return { 
              mint: mintAddress, 
              metadata: { name: metadata.name, symbol: metadata.symbol, image },
              decimals
            };
          } else if (decimals !== undefined) {
            // No metadata but we got decimals, update custom mint
            return { mint: mintAddress, metadata: null, decimals };
          }
        } catch (error) {
          console.warn(`[convert-form] Failed to fetch metadata for ${mintAddress}:`, error);
        }
        return null;
      });
      
      // Fetch decimals for all custom mints BEFORE building options to ensure correct balance display
      const decimalsPromises = Array.from(newCustomMints.keys()).map(async (mintAddress) => {
        const existingCustomMint = newCustomMints.get(mintAddress);
        // Only fetch if decimals might be wrong (default 9 or not set)
        if (existingCustomMint && (existingCustomMint.decimals === 9 || !existingCustomMint.decimals)) {
          try {
            const mintKey = new PublicKey(mintAddress);
            try {
              const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_PROGRAM_ID);
              return { mint: mintAddress, decimals: mintInfo.decimals };
            } catch {
              try {
                const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_2022_PROGRAM_ID);
                return { mint: mintAddress, decimals: mintInfo.decimals };
              } catch {
                return null;
              }
            }
          } catch {
            return null;
          }
        }
        return null;
      });
      
      const decimalsResults = await Promise.all(decimalsPromises);
      const finalCustomMints = new Map(newCustomMints);
      
      // Update custom mints with correct decimals before building options
      decimalsResults.forEach((result) => {
        if (result) {
          const existing = finalCustomMints.get(result.mint);
          if (existing && existing.decimals !== result.decimals) {
            finalCustomMints.set(result.mint, { ...existing, decimals: result.decimals });
          }
        }
      });
      
      // Update state with correct decimals
      if (decimalsResults.some(r => r !== null)) {
        setCustomMints(finalCustomMints);
      }
      
      // Build options with correct decimals
      const options = await buildOptions(publicBalances, privateBalances, finalCustomMints, currentMetadataMap, zTokenToOriginMap);
      setTokenOptions(options);
      
      // Fetch metadata in background (non-blocking) - update UI as it arrives
      Promise.all(metadataPromises).then((metadataResults) => {
        const newMetadataMap: Record<string, { name: string; symbol: string; image?: string }> = {};
        const updatedCustomMints = new Map(finalCustomMints);
        
        metadataResults.forEach((result) => {
          if (result) {
            if (result.metadata) {
              newMetadataMap[result.mint] = result.metadata;
            }
            // Update decimals if we fetched them
            if (result.decimals !== undefined) {
              const existing = updatedCustomMints.get(result.mint);
              if (existing) {
                updatedCustomMints.set(result.mint, { ...existing, decimals: result.decimals });
              } else if (result.metadata) {
                // New mint with metadata
                updatedCustomMints.set(result.mint, {
                  symbol: result.metadata.symbol,
                  decimals: result.decimals,
                  name: result.metadata.name,
                  image: result.metadata.image
                });
              } else {
                // Just decimals, no metadata
                updatedCustomMints.set(result.mint, {
                  symbol: result.mint.slice(0, 8),
                  decimals: result.decimals
                });
              }
            }
          }
        });
        
        // Merge new metadata with existing (preserve existing name/symbol if new ones are empty)
        setTokenMetadataMap(prev => {
          const merged: Record<string, { name: string; symbol: string; image?: string }> = { ...prev };
          const toCache: Record<string, { name: string; symbol: string; image?: string }> = {};
          
          Object.entries(newMetadataMap).forEach(([mint, newMeta]) => {
            const existing = prev[mint];
            merged[mint] = {
              // Use new metadata if it has values, otherwise keep existing cached data
              name: (newMeta.name && newMeta.name.trim()) ? newMeta.name : (existing?.name || ''),
              symbol: (newMeta.symbol && newMeta.symbol.trim()) ? newMeta.symbol : (existing?.symbol || ''),
              image: newMeta.image || existing?.image
            };
            toCache[mint] = merged[mint];
          });
          
          // Cache merged metadata in localStorage
          if (Object.keys(toCache).length > 0) {
            const { saveCachedMetadataBatch } = require('../../lib/tokenMetadata/storage');
            saveCachedMetadataBatch(toCache);
          }
          
          return merged;
        });
        if (updatedCustomMints.size !== customMints.size || 
            Array.from(updatedCustomMints.entries()).some(([k, v]) => {
              const old = customMints.get(k);
              return !old || old.decimals !== v.decimals || old.symbol !== v.symbol;
            })) {
          setCustomMints(updatedCustomMints);
        }
      }).catch(error => {
        console.warn('[convert-form] Error processing metadata results:', error);
      });

      // Options were already built and set above with correct decimals
      const ownedOptions = options.filter(o => o.isOwned);
      console.debug('[convert-form] Token options refreshed', { 
        totalOptions: options.length, 
        ownedOptions: ownedOptions.length,
        mode,
        allowedVariant: mode === 'to-private' ? 'public' : 'private',
        publicBalances: Array.from(publicBalances.entries()).map(([mint, bal]) => ({ mint, balance: bal.toString() })),
        privateBalances: Array.from(privateBalances.entries()).map(([mint, bal]) => ({ mint, balance: bal.toString() })),
        catalogZTokens: mints.filter(m => m.zTokenMint).map(m => ({ originMint: m.originMint, zTokenMint: m.zTokenMint, symbol: m.symbol })),
        ownedTokens: ownedOptions.map(o => ({ originMint: o.originMint, variant: o.variant, symbol: o.symbol, balance: o.balance.toString(), zTokenMint: o.zTokenMint }))
      });
      return options;
    } catch (error) {
      console.warn('[convert-form] failed to fetch token balances', error);
      const options = await buildOptions(new Map(), new Map(), new Map(), currentMetadataMap, new Map());
      setTokenOptions(options);
      return options;
    }
  }, [wallet.publicKey, connection, indexerClient, mints, mintStatuses, customMints, tokenMetadataMap]);
  
  const handlePasteMint = useCallback(async () => {
    if (!pastedMint.trim()) {
      return;
    }
    
    setPastedMintLoading(true);
    setPastedMintError(null);
    
    try {
      const mintKey = new PublicKey(pastedMint.trim());
      
      // Check if mint already exists in catalog
      if (mints.some(m => m.originMint === mintKey.toBase58())) {
        setPastedMintError('This mint is already in the token list');
        setPastedMintLoading(false);
        return;
      }
      
      // Check if mint already in custom mints
      if (customMints.has(mintKey.toBase58())) {
        setPastedMintError('This mint is already added');
        setPastedMintLoading(false);
        return;
      }
      
      // Fetch mint account info to get decimals
      let decimals = 9; // Default
      let programId = TOKEN_PROGRAM_ID;
      
      try {
        const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_PROGRAM_ID);
        decimals = mintInfo.decimals;
      } catch {
        try {
          const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_2022_PROGRAM_ID);
          decimals = mintInfo.decimals;
          programId = TOKEN_2022_PROGRAM_ID;
        } catch (error) {
          throw new Error('Invalid mint address or mint account not found');
        }
      }
      
      // Fetch metadata
      let symbol = mintKey.toBase58().slice(0, 8);
      let name = symbol;
      let image: string | undefined;
      
      try {
        // Add timeout to prevent hanging
        const metadata = await Promise.race([
          getTokenMetadata(connection, mintKey),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000))
        ]);
        if (metadata) {
          name = metadata.name;
          symbol = metadata.symbol;
          
          // Try to fetch image from IPFS URI if available
          if (metadata.uri && metadata.uri.startsWith('ipfs://')) {
            const cid = metadata.uri.replace('ipfs://', '');
            image = `https://ipfs.io/ipfs/${cid}`;
            
            // Try to fetch full metadata JSON from IPFS
            try {
              const metadataResponse = await fetch(`https://ipfs.io/ipfs/${cid}`);
              if (metadataResponse.ok) {
                const metadataJson = await metadataResponse.json();
                if (metadataJson.image) {
                  if (metadataJson.image.startsWith('ipfs://')) {
                    const imageCid = metadataJson.image.replace('ipfs://', '');
                    image = `https://ipfs.io/ipfs/${imageCid}`;
                  } else {
                    image = metadataJson.image;
                  }
                }
              }
            } catch {
              // Ignore IPFS metadata fetch errors
            }
          } else if (metadata.uri) {
            image = metadata.uri;
          }
        }
      } catch (error) {
        console.warn('[convert-form] Failed to fetch metadata for pasted mint:', error);
        // Continue with default values
      }
      
      // Add to custom mints
      const newCustomMints = new Map(customMints);
      newCustomMints.set(mintKey.toBase58(), { symbol, decimals, name, image });
      setCustomMints(newCustomMints);
      
      // Update metadata map
      if (name || image) {
        setTokenMetadataMap(prev => ({
          ...prev,
          [mintKey.toBase58()]: { name: name || symbol, symbol, image }
        }));
      }
      
      // Select this mint (even if not owned, it will show greyed out)
      setTokenSelection({
        originMint: mintKey.toBase58(),
        variant: 'public'
      });
      
      // Clear inputs
      setPastedMint('');
      setTokenSearchQuery('');
      setIsTokenDropdownOpen(false);
      
      // Refresh token options
      await refreshTokenOptions();
    } catch (error) {
      setPastedMintError((error as Error).message ?? 'Failed to add mint');
    } finally {
      setPastedMintLoading(false);
    }
  }, [pastedMint, connection, mints, customMints, refreshTokenOptions]);

  useEffect(() => {
    void refreshTokenOptions();
  }, [refreshTokenOptions, mints.length]); // Also refresh when mint catalog changes

  useEffect(() => {
    let cancelled = false;
    if (!mints.length) {
      setMintStatuses({});
      return;
    }
    const loadStatuses = async () => {
      setMintStatusLoading(true);
      setMintStatusError(null);
      try {
        const entries = await Promise.all(
          mints.map(async (mint) => {
            try {
              const { decoded } = await fetchMintMappingAccount(connection, new PublicKey(mint.originMint));
              const status = typeof decoded.status === 'number' ? decoded.status : MINT_STATUS.UNKNOWN;
              return [mint.originMint, status] as const;
            } catch (error) {
              console.warn('[convert-form] failed to fetch mint status', mint.originMint, error);
              return [mint.originMint, MINT_STATUS.UNKNOWN] as const;
            }
          })
        );
        if (!cancelled) {
          setMintStatuses(Object.fromEntries(entries));
        }
      } catch (error) {
        if (!cancelled) {
          setMintStatusError((error as Error).message ?? 'mint_status_error');
        }
      } finally {
        if (!cancelled) {
          setMintStatusLoading(false);
        }
      }
    };
    void loadStatuses();
    return () => {
      cancelled = true;
    };
  }, [connection, mints]);

  const allowedVariant: 'public' | 'private' = mode === 'to-private' ? 'public' : 'private';
  const filteredTokenOptions = useMemo(
    () => {
      const filtered = tokenOptions.filter((option) => option.variant === allowedVariant);
      console.debug('[convert-form] Filtered token options', { 
        mode, 
        allowedVariant, 
        totalOptions: tokenOptions.length, 
        filteredCount: filtered.length,
        allOptions: tokenOptions.map(o => ({ originMint: o.originMint, variant: o.variant, isOwned: o.isOwned, balance: o.balance.toString() }))
      });
      return filtered;
    },
    [tokenOptions, allowedVariant, mode]
  );
  
  // Filter options based on search query
  const searchableTokenOptions = useMemo(() => {
    if (!tokenSearchQuery.trim()) {
      // Default: show all owned tokens for the current mode, sorted by balance
      // If no owned tokens, show all tokens (user might want to see what's available)
      const ownedTokens = filteredTokenOptions.filter(opt => opt.isOwned);
      console.debug('[convert-form] Searchable token options (no query)', { 
        filteredCount: filteredTokenOptions.length,
        ownedCount: ownedTokens.length,
        ownedTokens: ownedTokens.map(o => ({ originMint: o.originMint, symbol: o.symbol, balance: o.balance.toString() }))
      });
      if (ownedTokens.length > 0) {
        return ownedTokens.sort((a, b) => {
          // Sort by balance descending
          if (b.balance > a.balance) return 1;
          if (a.balance > b.balance) return -1;
          return 0;
        });
      }
      // No owned tokens - show all available tokens sorted by symbol
      return filteredTokenOptions.sort((a, b) => {
        return a.symbol.localeCompare(b.symbol);
      });
    }
    
    const query = tokenSearchQuery.toLowerCase().trim();
    const matching = filteredTokenOptions.filter((option) => {
      const searchableText = `${option.name || ''} ${option.symbol} ${option.originMint}`.toLowerCase();
      return searchableText.includes(query);
    });
    
    // Sort: owned first, then by balance
    return matching.sort((a, b) => {
      if (a.isOwned && !b.isOwned) return -1;
      if (!a.isOwned && b.isOwned) return 1;
      if (b.balance > a.balance) return 1;
      if (a.balance > b.balance) return -1;
      return 0;
    });
  }, [filteredTokenOptions, tokenSearchQuery]);
  
  // Handle pasting mint address - check if it's a valid public key
  useEffect(() => {
    if (pastedMint.trim() && !pastedMintLoading) {
      const trimmed = pastedMint.trim();
      // Check if it's a valid public key format (Solana addresses are base58, typically 32-44 chars)
      // Minimum length: Solana addresses are at least 32 characters
      if (trimmed.length >= 32) {
        try {
          const mintKey = new PublicKey(trimmed);
          const mintStr = mintKey.toBase58();
          // Valid format, check if we need to fetch it
          const existsInOptions = filteredTokenOptions.some(opt => opt.originMint === mintStr);
          if (!existsInOptions && !customMints.has(mintStr)) {
            // New mint, fetch it
            void handlePasteMint();
          } else {
            // Already exists, just select it
            const option = filteredTokenOptions.find(opt => opt.originMint === mintStr);
            if (option) {
              setTokenSelection({
                originMint: option.originMint,
                variant: option.variant
              });
              setIsTokenDropdownOpen(false);
              setTokenSearchQuery('');
              setPastedMint('');
            }
          }
        } catch {
          // Not a valid public key, treat as search query - already handled by tokenSearchQuery
        }
      }
    }
  }, [pastedMint, pastedMintLoading, filteredTokenOptions, customMints, handlePasteMint]);
  // Update search query when selection changes (removed - handled by selectedTokenDisplayText)
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-token-selector]')) {
        setIsTokenDropdownOpen(false);
      }
    };
    if (isTokenDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isTokenDropdownOpen]);
  const selectedTokenOption = useMemo(
    () => {
      return tokenOptions.find((option) => option.originMint === originMint && option.variant === tokenVariant) ?? null;
    },
    [tokenOptions, originMint, tokenVariant]
  );
  
  // Compute token info for display, with fallbacks
  const tokenDisplayInfo = useMemo<{ name?: string; symbol: string; image?: string; displayBalance: string } | null>(() => {
    if (!originMint) {
      return null;
    }
    
    if (selectedTokenOption) {
      return {
        name: selectedTokenOption.name,
        symbol: selectedTokenOption.symbol,
        image: selectedTokenOption.image,
        displayBalance: selectedTokenOption.displayBalance
      };
    }
    
    // Fallback to mintConfig and metadata
    if (mintConfig) {
      return {
        name: tokenMetadataMap[originMint]?.name || undefined,
        symbol: tokenVariant === 'private' ? `z${mintConfig.symbol}` : (mintConfig.symbol || tokenMetadataMap[originMint]?.symbol || originMint.slice(0, 8)),
        image: tokenMetadataMap[originMint]?.image,
        displayBalance: ''
      };
    }
    
    // Last resort: use metadata or mint address
    return {
      name: tokenMetadataMap[originMint]?.name,
      symbol: tokenMetadataMap[originMint]?.symbol || originMint.slice(0, 8),
      image: tokenMetadataMap[originMint]?.image,
      displayBalance: ''
    };
  }, [originMint, selectedTokenOption, mintConfig, tokenMetadataMap, tokenVariant]);
  
  // Prioritize tokenMetadataMap since it has the actual symbol from chain metadata
  const selectedTokenSymbol = useMemo(() => {
    if (!originMint) {
      return '';
    }
    if (tokenMetadataMap[originMint]?.symbol) {
      return tokenMetadataMap[originMint].symbol;
    }
    if (tokenDisplayInfo?.symbol) {
      return tokenDisplayInfo.symbol;
    }
    return selectedTokenOption?.symbol || mintConfig?.symbol || '';
  }, [originMint, tokenMetadataMap, tokenDisplayInfo?.symbol, selectedTokenOption?.symbol, mintConfig?.symbol]);
  
  const activitySymbol = useMemo(() => {
    if (!originMint) {
      return '';
    }
    return (
      selectedTokenSymbol ||
      tokenDisplayInfo?.symbol ||
      mintConfig?.symbol ||
      (originMint ? originMint.slice(0, 6) : '')
    );
  }, [originMint, selectedTokenSymbol, tokenDisplayInfo?.symbol, mintConfig?.symbol]);
  
  const zTokenSymbol = useMemo(() => (selectedTokenSymbol ? `z${selectedTokenSymbol}` : ''), [selectedTokenSymbol]);
  const shieldActivitySymbol = useMemo(() => {
    if (zTokenSymbol) {
      return zTokenSymbol;
    }
    if (activitySymbol) {
      return activitySymbol.startsWith('z') ? activitySymbol : `z${activitySymbol}`;
    }
    return 'zTOKEN';
  }, [zTokenSymbol, activitySymbol]);
  const unshieldActivitySymbol = useMemo(() => activitySymbol || 'TOKEN', [activitySymbol]);
  const redeemDisplaySymbol = useMemo(() => {
    if (!originMint) {
      return '—';
    }
    const symbol = mode === 'to-private' ? zTokenSymbol || selectedTokenSymbol : selectedTokenSymbol;
    return symbol || '—';
  }, [mode, zTokenSymbol, selectedTokenSymbol, originMint]);
  
  const selectedMintStatus = mintStatuses[originMint];
  const mintIsFrozen = selectedMintStatus === MINT_STATUS.FROZEN;

  useEffect(() => {
    if (!mints.length) {
      setSelectionInitialized(false);
      if (tokenSelection.originMint && !tokenOptions.some(opt => opt.originMint === tokenSelection.originMint)) {
        console.log('🚫 CLEARING: No mints available and token not in options');
        setTokenSelection((prev) => ({ ...prev, originMint: '' }));
        setSelectedTokenDisplayText('');
      }
      return;
    }
    const desiredVariant: 'public' | 'private' = mode === 'to-private' ? 'public' : 'private';
    if (!selectionInitialized) {
      // Don't auto-select a token - let user choose
      setSelectionInitialized(true);
      return;
    }
    // Only clear if token is not in catalog AND not in tokenOptions (custom tokens)
    if (tokenSelection.originMint && 
        !mints.some((mint) => mint.originMint === tokenSelection.originMint) &&
        !tokenOptions.some(opt => opt.originMint === tokenSelection.originMint)) {
      // If selected token is no longer valid anywhere, clear selection
      console.log('🚫 CLEARING: Token not in mints catalog or tokenOptions:', tokenSelection.originMint);
      setTokenSelection({
        originMint: '',
        variant: desiredVariant
      });
      setSelectedTokenDisplayText('');
      return;
    }
    if (tokenSelection.variant !== desiredVariant) {
      console.log('🔄 UPDATING VARIANT:', { from: tokenSelection.variant, to: desiredVariant, originMint: tokenSelection.originMint });
      setTokenSelection((prev) => ({
        ...prev,
        variant: desiredVariant
      }));
    }
  }, [mints, selectionInitialized, tokenSelection.originMint, tokenSelection.variant, mode, tokenOptions]);


  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setStoredNotes(readStoredNotes());
  }, []);

  useEffect(() => {
    writeStoredNotes(storedNotes);
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
        // LAZY INITIALIZATION: If pool doesn't exist yet, use default empty root
        // The pool will be initialized on first shield
        const defaultEmptyRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (mountedRef.current) {
          setRoots({
            current: defaultEmptyRoot,
            recent: [],
            source: 'default'
          });
          setCachedRoots({
            mint: originMint,
            current: defaultEmptyRoot,
            recent: [],
            source: 'default'
          });
          setRootsError(null); // Clear error - we have a valid default root
        }
        return { current: defaultEmptyRoot, recent: [], source: 'default' };
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
    const noteMint = mintConfig?.zTokenMint ?? mintConfig?.originMint ?? '';
    let rawAmount: string | undefined;
    try {
      const parsed = parseUiAmountToBaseUnits(unwrapAdvanced.noteAmount.trim() || amount || '0', decimals, 'note amount');
      rawAmount = parsed.toString();
    } catch {
      rawAmount = undefined;
    }
    const entry: StoredNoteRecord = {
      id,
      label,
      noteId,
      spendingKey,
      amount: unwrapAdvanced.noteAmount.trim() || amount || '0',
      rawAmount,
      decimals,
      mint: noteMint || undefined,
      owner: wallet.publicKey?.toBase58(),
      changeRecipient: unwrapAdvanced.changeRecipient.trim() || undefined,
      createdAt: Date.now()
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
    if (mintIsFrozen) {
      setError('This mint is currently frozen by governance. Wait until it is thawed before converting.');
      return;
    }
    setSubmitting.on();
    setResult(null);
    setProofPreview(null);
    setError(null);

    try {
      if (!wallet.publicKey) {
        throw new Error('Connect your wallet before converting.');
      }
      if (!selectedTokenOption) {
        throw new Error('Select a token before converting.');
      }
      if (!originMint) {
        throw new Error('Select a token before converting.');
      }

      // Derive poolId from originMint (works for all SPL tokens)
      const originMintKey = new PublicKey(originMint);
      const poolId = mintConfig?.poolId ?? derivePoolState(originMintKey).toBase58();
      const mintId = originMint;

      let rootValue = resolvedOldRoot;
      const latestRoots = await refreshRoots();
      if (latestRoots?.current) {
        rootValue = latestRoots.current;
      }

      // Final fallback: fetch root directly from chain if indexer doesn't have it
      if (!rootValue) {
        try {
          const commitmentTreeKey = deriveCommitmentTree(originMintKey);
          const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
          if (commitmentTreeAccount) {
            const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
            rootValue = bytesLEToCanonicalHex(Buffer.from(treeState.currentRoot));
            console.info('[convert-form] Fetched root directly from chain:', rootValue);
          }
        } catch (chainError) {
          console.warn('[convert-form] Failed to fetch root from chain:', chainError);
        }
      }

      // LAZY INITIALIZATION: Use default empty root if pool not initialized yet
      // The pool will be initialized on first shield
      if (!rootValue) {
        rootValue = '0x0000000000000000000000000000000000000000000000000000000000000000';
      }

      // Get decimals from mintConfig, selectedTokenOption, or customMints
      let decimals = mintConfig?.decimals ?? selectedTokenOption?.decimals ?? 0;
      if (decimals === 0 && !mintConfig) {
        // Try to get decimals from customMints if available
        const customMint = customMints.get(originMint);
        if (customMint?.decimals) {
          decimals = customMint.decimals;
        }
      }

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

        await preparePool({
          connection,
          wallet,
          originMint
        });

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
          twinMint: mintConfig?.zTokenMint ?? null
        });

        try {
          await indexerClient.adjustBalance(
            wallet.publicKey.toBase58(),
            mintConfig?.zTokenMint ?? originMint,
            baseAmount
          );
        } catch (error) {
          console.warn('Failed to adjust private balance', error);
        }
        const displayAmount = formatBaseUnitsToUi(baseAmount, decimals);
        setResult(`Shielded ${displayAmount} ${shieldActivitySymbol}. Signature: ${signature}`);
        if (wallet.publicKey) {
          const autoStoredNote: StoredNoteRecord = {
            id:
              typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random()}`,
            label: `Wrap ${new Date().toLocaleTimeString()}`,
            noteId: wrapAdvanced.depositId,
            spendingKey: wrapAdvanced.blinding,
            amount: displayAmount,
            rawAmount: baseAmount.toString(),
            decimals,
            mint: mintConfig?.zTokenMint ?? originMint,
            owner: wallet.publicKey.toBase58(),
            createdAt: Date.now()
          };
          setStoredNotes((prev) => {
            const filtered = prev.filter(
              (entry) => entry.noteId !== autoStoredNote.noteId || entry.spendingKey !== autoStoredNote.spendingKey
            );
            return [...filtered, autoStoredNote];
          });
        }
        if (wallet.publicKey) {
          void recordWalletActivity({
            wallet: wallet.publicKey.toBase58(),
            id: signature,
            signature,
            type: 'wrap',
            symbol: shieldActivitySymbol,
            amount: displayAmount,
            timestamp: Date.now()
          }, { viewId: viewingId ?? undefined });
        }
        await refreshTokenOptions();
      } else {
        if (tokenVariant !== 'private') {
          throw new Error('Select a private token to unshield.');
        }
        // When unshielding, we need a valid originMint (public mint) to unshield to
        // Check that we can find the mint config or have the origin mint from tokenOptions
        if (!mintConfig && !selectedTokenOption) {
          throw new Error('Unable to determine origin mint for unshielding. Token may not be registered.');
        }
        // Ensure we have a valid origin mint (public mint) - either from mintConfig or tokenOptions
        const actualOriginMint = mintConfig?.originMint || selectedTokenOption?.originMint || originMint;
        if (!actualOriginMint) {
          throw new Error('This token does not support private redemptions.');
        }
        await ensureWalletFeeBalance();
        const destinationKey = await resolvePublicKey(unwrapAdvanced.destination, wallet.publicKey);
        // For unshielding, destination mint is the origin mint (public mint), not the zToken mint
        const destinationMint = actualOriginMint || originMint;
        await ensureDestinationAccountFunding({
          owner: destinationKey,
          mint: destinationMint,
          tokenProgram: TOKEN_PROGRAM_ID
        });

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

        // For unshield proof, mintId should be the origin mint (public mint), poolId should match
        const unshieldOriginMint = actualOriginMint || originMint;
        const unshieldPoolId = mintConfig?.poolId || derivePoolState(new PublicKey(unshieldOriginMint)).toBase58();
        
        const payload = {
          oldRoot: rootValue,
          amount: amountValue.toString(),
          fee: feeValue.toString(),
          destPubkey: destinationKey.toBase58(),
          mode: 'origin',
          mintId: unshieldOriginMint,
          poolId: unshieldPoolId,
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

        // For unshielding, privateMint is the zToken mint (what we're unshielding from)
        const privateMint = selectedTokenOption?.zTokenMint || mintConfig?.zTokenMint;
        if (!privateMint) {
          throw new Error('Unable to determine zToken mint for unshielding.');
        }

        // For unshielding, originMint is the public mint we're unshielding to
        // Use actualOriginMint if we resolved it above, otherwise fall back to originMint from tokenSelection
        const unwrapOriginMint = actualOriginMint || originMint;
        const unwrapPoolId = mintConfig?.poolId || derivePoolState(new PublicKey(unwrapOriginMint)).toBase58();
        const zTokenMintForUnwrap = selectedTokenOption?.zTokenMint || mintConfig?.zTokenMint;
        
        const unwrapParams = {
          connection,
          wallet,
          originMint: unwrapOriginMint,
          amount: amountValue,
          poolId: unwrapPoolId,
          destination: destinationKey.toBase58(),
          mode: 'origin',
          proof: proofResponse,
          twinMint: zTokenMintForUnwrap
        } as {
          connection: typeof connection;
          wallet: typeof wallet;
          originMint: string;
          amount: bigint;
          poolId: string;
          destination: string;
          mode: 'origin';
          proof: ProofResponse;
          twinMint?: string;
        };

        if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
          // eslint-disable-next-line no-console
          console.info('[convert] unwrap params', unwrapParams);
        }

        let unwrapSignature: string;
        try {
          unwrapSignature = await unwrapSdk(unwrapParams);
        } catch (caught) {
          throw new Error(normaliseSendError(caught));
        }

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
        setResult(`Unshielded ${displayAmount} ${unshieldActivitySymbol}. Signature: ${unwrapSignature}`);
        if (wallet.publicKey) {
          void recordWalletActivity({
            wallet: wallet.publicKey.toBase58(),
            id: unwrapSignature,
            signature: unwrapSignature,
            type: 'unwrap',
            symbol: unshieldActivitySymbol,
            amount: displayAmount,
            timestamp: Date.now()
          }, { viewId: viewingId ?? undefined });
        }
        await refreshTokenOptions();
      }
      void refreshRoots();
      void refreshNullifiers();
      if (notesSnapshot) {
        void handleFetchNotes();
      }
    } catch (caught) {
      const error = caught as Error;
      let errorMessage = error.message;
      
      // Provide helpful error message for transaction size issues
      if (errorMessage.includes('Transaction too large') || errorMessage.includes('transaction size')) {
        if (!mintConfig) {
          errorMessage = 'Transaction too large. This token needs to be registered in the catalog with a lookup table to reduce transaction size. Please contact support to register this token, or use a token that is already in the catalog.';
        } else {
          errorMessage = 'Transaction too large. The transaction exceeds Solana\'s size limit. Try reducing the amount or contact support.';
        }
      }
      
      setError(errorMessage);
    } finally {
      setSubmitting.off();
    }
  };

  if (mintCatalogError) {
    return (
      <Alert status="error" variant="left-accent">
        <AlertIcon />
        <AlertDescription>
          Unable to load mint catalogue. {mintCatalogError}. Try refreshing the page or regenerating the devnet.
        </AlertDescription>
      </Alert>
    );
  }

  if (mintCatalogLoading && !selectionInitialized) {
    return (
      <Stack spacing={4}>
        <Heading size="lg">Shield and unshield tokens</Heading>
        <Text color="whiteAlpha.700">Loading mint catalogue…</Text>
      </Stack>
    );
  }

  if (!mintCatalogLoading && !mints.length) {
    return (
      <Alert status="info" variant="left-accent">
        <AlertIcon />
        <AlertDescription>
          No origin mints are registered yet. Use the Faucet page to create a local token, then refresh this view.
        </AlertDescription>
      </Alert>
    );
  }

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
            Shield and unshield tokens
          </Heading>
          <Text color="whiteAlpha.700">
            Move value into a private balance or bring it back to the public mint from a single flow.
          </Text>
        </Stack>
        <HStack spacing={0} rounded="lg" border="1px solid rgba(245,178,27,0.24)" overflow="hidden">
          <Button
            flex={1}
            variant="ghost"
            borderRadius="none"
            py={3}
            fontSize="md"
            fontWeight="semibold"
            bg={mode === 'to-private' ? 'rgba(245,178,27,0.15)' : 'transparent'}
            color={mode === 'to-private' ? 'brand.100' : 'whiteAlpha.700'}
            borderRight="1px solid rgba(245,178,27,0.24)"
            _hover={{ bg: 'rgba(245,178,27,0.1)' }}
            onClick={() => {
              setMode('to-private');
              setTokenSelection((prev) => ({ ...prev, variant: 'public' }));
            }}
          >
            Shield
          </Button>
          <Button
            flex={1}
            variant="ghost"
            borderRadius="none"
            py={3}
            fontSize="md"
            fontWeight="semibold"
            bg={mode === 'to-public' ? 'rgba(245,178,27,0.15)' : 'transparent'}
            color={mode === 'to-public' ? 'brand.100' : 'whiteAlpha.700'}
            _hover={{ bg: 'rgba(245,178,27,0.1)' }}
            onClick={() => {
              setMode('to-public');
              setTokenSelection((prev) => ({ ...prev, variant: 'private' }));
            }}
          >
            Unshield
          </Button>
        </HStack>
        <Text color="whiteAlpha.600" fontSize="sm">
          {mode === 'to-private'
            ? 'Shield public tokens into a private balance.'
            : 'Unshield private funds back to the public mint.'}
        </Text>

        {mintStatusError && (
          <Alert status="warning" variant="left-accent">
            <AlertIcon />
            <AlertDescription>
              Unable to refresh mint status. Transactions may fail if the selected mint is frozen. {mintStatusError}
            </AlertDescription>
          </Alert>
        )}

        <FormControl isDisabled={mintCatalogLoading}>
          <FormLabel color="whiteAlpha.700">Token</FormLabel>
          <Box position="relative" data-token-selector>
            {originMint && !isTokenDropdownOpen ? (
              <Box
                bg="rgba(18, 16, 14, 0.78)"
                border="1px solid rgba(245,178,27,0.24)"
                rounded="lg"
                p={3}
                cursor="pointer"
                onClick={() => {
                  setIsTokenDropdownOpen(true);
                  setTokenSearchQuery('');
                  // Refresh token options when opening dropdown to ensure we have latest balances
                  void refreshTokenOptions();
                }}
                _hover={{ bg: 'rgba(18, 16, 14, 0.88)', borderColor: 'rgba(245,178,27,0.36)' }}
                transition="all 0.2s"
              >
                <HStack spacing={3} align="center" justify="space-between">
                  <HStack spacing={3} align="center" flex={1} minW={0}>
                    {tokenDisplayInfo?.image && (
                      <Box
                        w={10}
                        h={10}
                        rounded="full"
                        bg="whiteAlpha.100"
                        border="1px solid"
                        borderColor="whiteAlpha.200"
                        overflow="hidden"
                        flexShrink={0}
                      >
                        <img
                          src={tokenDisplayInfo.image}
                          alt={tokenDisplayInfo.symbol || ''}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </Box>
                    )}
                    <VStack spacing={0} align="start" flex={1} minW={0}>
                      <Text fontSize="md" color="whiteAlpha.900" fontWeight="medium" isTruncated maxW="100%">
                        {tokenDisplayInfo?.name || tokenDisplayInfo?.symbol || originMint.slice(0, 8)}
                      </Text>
                      <HStack spacing={1} align="center">
                        {tokenDisplayInfo?.name && (
                          <Text fontSize="sm" color="whiteAlpha.600" isTruncated maxW="100%">
                            {tokenDisplayInfo.symbol}
                          </Text>
                        )}
                        {tokenDisplayInfo?.displayBalance && (
                          <>
                            {tokenDisplayInfo?.name && <Text fontSize="sm" color="whiteAlpha.500">·</Text>}
                            <Text fontSize="sm" color="whiteAlpha.500" isTruncated maxW="100%">
                              {tokenDisplayInfo.displayBalance} {tokenDisplayInfo.symbol}
                            </Text>
                          </>
                        )}
                      </HStack>
                    </VStack>
                  </HStack>
                  <IconButton
                    aria-label="Clear token selection"
                    icon={<Icon as={X} size={18} />}
                    size="sm"
                    variant="ghost"
                    colorScheme="whiteAlpha"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTokenSelection({ originMint: '', variant: 'public' });
                      setTokenSearchQuery('');
                      setPastedMint('');
                    }}
                  />
                </HStack>
              </Box>
            ) : (
              <InputGroup>
                <Input
                  placeholder={mode === 'to-private' ? 'Search or paste mint address...' : 'Search or paste zToken mint...'}
                  value={tokenSearchQuery}
                  onChange={(e) => {
                    setTokenSearchQuery(e.target.value);
                    setPastedMint(e.target.value);
                    setIsTokenDropdownOpen(true);
                  }}
                  onPaste={(e) => {
                    const pastedText = e.clipboardData.getData('text/plain');
                    if (pastedText) {
                      setTokenSearchQuery(pastedText);
                      setPastedMint(pastedText);
                      setIsTokenDropdownOpen(true);
                      e.preventDefault();
                    }
                  }}
                  onFocus={() => {
                    setIsTokenDropdownOpen(true);
                    // Refresh token options when focusing to ensure we have latest balances
                    void refreshTokenOptions();
                  }}
                  onBlur={(e) => {
                    const relatedTarget = e.relatedTarget as HTMLElement;
                    if (!relatedTarget || !relatedTarget.closest('[data-token-selector]')) {
                      setTimeout(() => {
                        if (!selectingTokenRef.current) {
                          setIsTokenDropdownOpen(false);
                          if (!originMint) {
                            setTokenSearchQuery('');
                            setPastedMint('');
                          }
                        }
                      }, 200);
                    }
                  }}
                  bg="rgba(18, 16, 14, 0.78)"
                  onClick={() => {
                    setIsTokenDropdownOpen(true);
                    // Refresh token options when clicking to ensure we have latest balances
                    void refreshTokenOptions();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchableTokenOptions.length === 1) {
                      e.preventDefault();
                      const option = searchableTokenOptions[0];
                      setTokenSelection({
                        originMint: option.originMint,
                        variant: option.variant
                      });
                      setIsTokenDropdownOpen(false);
                      setTokenSearchQuery('');
                      setPastedMint('');
                    } else if (e.key === 'Escape') {
                      setIsTokenDropdownOpen(false);
                      setTokenSearchQuery('');
                      setPastedMint('');
                    }
                  }}
                />
              </InputGroup>
            )}
            {isTokenDropdownOpen && (
              <>
                {searchableTokenOptions.length === 0 && (
                  <Box
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    mt={1}
                    bg="rgba(18, 16, 14, 0.98)"
                    border="1px solid rgba(245,178,27,0.24)"
                    rounded="lg"
                    p={3}
                    zIndex={1000}
                  >
                    <Text color="gray.400" fontSize="sm">
                      No tokens found. {filteredTokenOptions.length === 0 ? 'No tokens available for this mode.' : 'Try searching by name, symbol, or mint address.'}
                    </Text>
                  </Box>
                )}
                {searchableTokenOptions.length > 0 && (
              <Box
                position="absolute"
                top="100%"
                left={0}
                right={0}
                mt={1}
                bg="rgba(18, 16, 14, 0.98)"
                border="1px solid rgba(245,178,27,0.24)"
                rounded="lg"
                maxH="300px"
                overflowY="auto"
                zIndex={1000}
                boxShadow="0 4px 12px rgba(0,0,0,0.5)"
              >
                <VStack spacing={0} align="stretch">
                  {searchableTokenOptions.map((option) => {
                    const displayName = option.name || option.symbol;
                    const displaySymbol = option.symbol;
                    const isSelected = option.originMint === originMint && option.variant === tokenVariant;
                    return (
                      <Tooltip
                        key={`${option.variant}:${option.originMint}`}
                        label={`Mint: ${option.originMint}`}
                        placement="right"
                      >
                        <Box
                          px={4}
                          py={3}
                          cursor={option.disabled && !option.isOwned ? 'not-allowed' : 'pointer'}
                          bg={isSelected ? 'rgba(245,178,27,0.1)' : 'transparent'}
                          _hover={!option.disabled || option.isOwned ? { bg: 'rgba(245,178,27,0.05)' } : {}}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            selectingTokenRef.current = true;
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('🖱️ TOKEN CLICKED:', { originMint: option.originMint, variant: option.variant });
                            selectingTokenRef.current = true;
                            setTokenSelection({
                              originMint: option.originMint,
                              variant: option.variant
                            });
                            console.log('✅ SET TOKEN SELECTION:', { originMint: option.originMint, variant: option.variant });
                            setIsTokenDropdownOpen(false);
                            setTokenSearchQuery('');
                            setPastedMint('');
                            setTimeout(() => {
                              selectingTokenRef.current = false;
                            }, 100);
                          }}
                          opacity={!option.isOwned ? 0.5 : 1}
                          borderBottom="1px solid"
                          borderColor="whiteAlpha.100"
                        >
                          <HStack spacing={3} align="center">
                            {option.image && (
                              <Box
                                w={8}
                                h={8}
                                rounded="full"
                                bg="whiteAlpha.100"
                                border="1px solid"
                                borderColor="whiteAlpha.200"
                                overflow="hidden"
                                flexShrink={0}
                              >
                                <img
                                  src={option.image}
                                  alt={displayName}
                                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                  }}
                                />
                              </Box>
                            )}
                            <VStack spacing={0} align="start" flex={1} minW={0}>
                              <HStack spacing={2}>
                                <Text fontWeight="medium" color="whiteAlpha.900" isTruncated>
                                  {displayName}
                                </Text>
                                {displaySymbol !== displayName && (
                                  <Text fontSize="xs" color="whiteAlpha.500">
                                    ({displaySymbol})
                                  </Text>
                                )}
                              </HStack>
                              <HStack spacing={2} fontSize="xs" color="whiteAlpha.600">
                                <Text>
                                  {option.displayBalance} {displaySymbol}
                                </Text>
                                {!option.isOwned && (
                                  <Text color="red.300">(Not owned)</Text>
                                )}
                              </HStack>
                            </VStack>
                          </HStack>
                        </Box>
                      </Tooltip>
                    );
                  })}
                </VStack>
              </Box>
                )}
              </>
            )}
            {pastedMintError && (
              <Text fontSize="xs" color="red.300" mt={1}>
                {pastedMintError}
              </Text>
            )}
            {pastedMintLoading && (
              <Text fontSize="xs" color="whiteAlpha.500" mt={1}>
                Loading mint info...
              </Text>
            )}
          </Box>
          <FormHelperText color="whiteAlpha.500">
            {mode === 'to-private'
              ? selectedTokenSymbol
                ? `Private balance will appear as ${zTokenSymbol || selectedTokenSymbol}.`
                : 'Select a token to see the private balance symbol.'
              : selectedTokenSymbol
                ? `Public balance will appear as ${selectedTokenSymbol}.`
                : 'Select a token to see the public symbol.'}
          </FormHelperText>
          {selectedTokenOption && (
            <FormHelperText color="whiteAlpha.500">
              Available: {selectedTokenOption.displayBalance} {selectedTokenOption.symbol}
            </FormHelperText>
          )}
          {mintStatusLoading && <FormHelperText color="whiteAlpha.500">Checking mint status…</FormHelperText>}
          {typeof selectedMintStatus === 'number' && !mintStatusLoading && (
            <FormHelperText color={mintIsFrozen ? 'orange.300' : 'green.300'}>
              {mintIsFrozen
                ? 'This mint is currently frozen by governance. Shielding and unshielding are paused.'
                : 'Mint is active.'}
            </FormHelperText>
          )}
        </FormControl>

        {mintIsFrozen && (
          <Alert status="warning" variant="left-accent">
            <AlertIcon />
            <AlertDescription>
              Governance has frozen this mint. You can view balances but must wait for it to be thawed before shielding or
              unshielding.
            </AlertDescription>
          </Alert>
        )}

        <FormControl isRequired>
          <FormLabel color="whiteAlpha.700">Amount</FormLabel>
          <InputGroup>
            <NumberInput
              min={0}
              value={amount}
              onChange={(valueString) => setAmount(valueString)}
              precision={mintConfig?.decimals ?? 0}
              clampValueOnBlur={false}
              flex={1}
            >
              <NumberInputField placeholder="0" inputMode="decimal" pr="4.5rem" />
            </NumberInput>
            {selectedTokenOption && selectedTokenOption.displayBalance && (
              <InputRightElement width="4.5rem" pr={1}>
                <Button
                  h="1.75rem"
                  size="sm"
                  variant="ghost"
                  colorScheme="brand"
                  onClick={() => {
                    if (selectedTokenOption.displayBalance) {
                      setAmount(selectedTokenOption.displayBalance.replace(/,/g, ''));
                    }
                  }}
                >
                  Max
                </Button>
              </InputRightElement>
            )}
          </InputGroup>
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
              Direction: {mode === 'to-private' ? 'Shield' : 'Unshield'}
            </Text>
          </HStack>
        </Box>

        <Button
          type="submit"
          size="lg"
          variant="glow"
          isLoading={isSubmitting}
          loadingText={mode === 'to-private' ? 'Shielding' : 'Unshielding'}
          isDisabled={
            !amount || !wallet.publicKey || mintIsFrozen || mintStatusLoading || !selectedTokenOption || mintCatalogLoading
          }
        >
          {wallet.publicKey ? (mode === 'to-private' ? 'Shield now' : 'Unshield now') : 'Connect wallet to proceed'}
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

