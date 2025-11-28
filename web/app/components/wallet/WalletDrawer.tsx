'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Code,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  Editable,
  EditableInput,
  EditablePreview,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputRightElement,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  VStack,
  Textarea,
  Tooltip,
  useBoolean,
  useClipboard,
  useDisclosure,
  useToast
} from '@chakra-ui/react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMint
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import { ProofClient } from '../../lib/proofClient';
import { transfer, getTokenMetadata } from '../../lib/sdk';
import { canonicalizeHex } from '../../lib/onchain/utils';
import { poseidonHashMany } from '../../lib/onchain/poseidon';
import type { StoredNoteRecord } from '../../lib/notes/storage';
import { readStoredNotes, writeStoredNotes } from '../../lib/notes/storage';
import { Coins, Copy, Plus, Trash2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalWallet } from './LocalWalletContext';
import { formatBaseUnitsToUi } from '../../lib/format';
import { IndexerClient } from '../../lib/indexerClient';
import { useMintCatalog } from '../providers/MintCatalogProvider';
import {
  fetchWalletActivity,
  subscribeToWalletActivity,
  WalletActivityEntry,
  recordWalletActivity
} from '../../lib/client/activityLog';

interface TokenBalance {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  rawAmount: string;
  program: 'token' | 'token2022';
}

interface TransactionEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  changeSol: number;
  description: string;
  status: 'success' | 'failed';
  fee?: number; // Transaction fee in SOL
  tokenTransfers?: Array<{
    mint: string;
    symbol: string;
    amount: string;
    decimals: number;
    direction: 'in' | 'out';
  }>;
}

interface UnifiedActivityEntry {
  signature: string;
  timestamp: number;
  type: 'wrap' | 'unwrap' | 'transfer' | 'sol' | 'token';
  description: string;
  status: 'success' | 'failed';
  solChange?: number;
  fee?: number;
  tokenTransfers?: Array<{
    mint: string;
    symbol: string;
    amount: string;
    decimals: number;
    direction: 'in' | 'out';
  }>;
}

type AssetKind = 'sol' | 'spl' | 'ztoken';

interface SendAssetContext {
  kind: AssetKind;
  mint: string | null;
  symbol: string;
  decimals: number;
  availableDisplay: string;
  availableUiAmount: string;
  availableAmount: number | bigint;
  isPrivate: boolean;
  program?: 'token' | 'token2022';
}

interface SendAssetInput {
  recipient: string;
  amount: string;
  memo?: string;
  context: SendAssetContext;
}

function formatAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function parseAmountToBaseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Enter an amount to send.');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Amount must be numeric.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount supports up to ${decimals} decimal places.`);
  }
  const normalizedFraction = fraction.padEnd(decimals, '0');
  const unitsString = `${whole}${normalizedFraction}`.replace(/^0+/, '') || '0';
  return BigInt(unitsString);
}

function CopyAddressButton({
  value,
  ariaLabel = 'Copy address',
  stopPropagation = false
}: {
  value: string;
  ariaLabel?: string;
  stopPropagation?: boolean;
}) {
  const { hasCopied, onCopy } = useClipboard(value);

  return (
    <Tooltip label={hasCopied ? 'Copied' : 'Copy address'}>
      <IconButton
        icon={<Icon as={Copy} boxSize={3} />}
        aria-label={ariaLabel}
        variant="ghost"
        size="xs"
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          onCopy();
        }}
      />
    </Tooltip>
  );
}

function createMemoInstruction(memo?: string) {
  if (!memo || memo.trim().length === 0) {
    return null;
  }
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memo, 'utf8')
  });
}

export function WalletDrawerLauncher() {
  const disclosure = useDisclosure();

  return (
    <>
      <Tooltip label="Wallet">
        <IconButton
          aria-label="Open wallet"
          icon={<Icon as={Wallet} />}
          variant="ghost"
          onClick={disclosure.onOpen}
        />
      </Tooltip>
      {disclosure.isOpen && <WalletDrawerContent disclosure={disclosure} />}
    </>
  );
}

const BALANCE_REFRESH_INTERVAL = 10_000;
const TRANSACTION_LIMIT = 10;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ZERO_HEX = '0x0';

function randomFieldScalar(): bigint {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(31);
    window.crypto.getRandomValues(bytes);
    return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  }
  const fallback = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) || 1;
  return BigInt(fallback);
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

interface StoredNoteWithAmount extends StoredNoteRecord {
  rawAmount: string;
}

function normaliseStoredNoteAmount(
  note: StoredNoteRecord,
  fallbackDecimals: number
): StoredNoteWithAmount | null {
  if (note.rawAmount) {
    return { ...note, rawAmount: note.rawAmount };
  }
  const decimals = note.decimals ?? fallbackDecimals;
  try {
    const parsed = parseAmountToBaseUnits(note.amount, decimals);
    return { ...note, rawAmount: parsed.toString() };
  } catch {
    return null;
  }
}

function selectNotesForAmount(notes: StoredNoteWithAmount[], target: bigint): StoredNoteWithAmount[] {
  if (!notes.length) {
    throw new Error('No shielded notes available.');
  }
  const sorted = [...notes].sort((a, b) => {
    const diff = BigInt(a.rawAmount) - BigInt(b.rawAmount);
    if (diff === 0n) {
      return 0;
    }
    return diff > 0n ? 1 : -1;
  });
  const single = sorted.find((entry) => BigInt(entry.rawAmount) >= target);
  if (single) {
    return [single];
  }
  let bestPair: { total: bigint; notes: [StoredNoteWithAmount, StoredNoteWithAmount] } | null = null;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      const total = BigInt(sorted[i].rawAmount) + BigInt(sorted[j].rawAmount);
      if (total >= target) {
        if (!bestPair || total < bestPair.total) {
          bestPair = { total, notes: [sorted[i]!, sorted[j]!] };
        }
      }
    }
  }
  if (bestPair) {
    return bestPair.notes;
  }
  throw new Error('Not enough shielded note liquidity to cover this amount.');
}

async function buildAmountCommitments(entries: { amount: bigint; blinding: bigint }[]): Promise<string[]> {
  const commitments: string[] = [];
  for (const entry of entries) {
    if (entry.amount === 0n) {
      commitments.push(ZERO_HEX);
      continue;
    }
    const hash = await poseidonHashMany([entry.amount, entry.blinding]);
    commitments.push(bytesToHex(hash));
  }
  return commitments;
}

function parseTransferPublicInputs(
  publicInputs: string[] | undefined,
  inputCount: number,
  outputCount: number
) {
  if (!publicInputs) {
    throw new Error('Transfer proof missing public inputs.');
  }
  const expected = 2 + inputCount + outputCount + 2;
  if (publicInputs.length !== expected) {
    throw new Error(`Unexpected transfer public inputs: expected ${expected}, received ${publicInputs.length}`);
  }
  const oldRoot = canonicalizeHex(publicInputs[0]!);
  const newRoot = canonicalizeHex(publicInputs[1]!);
  const nullifiers = publicInputs.slice(2, 2 + inputCount).map((entry) => canonicalizeHex(entry ?? ZERO_HEX));
  const offset = 2 + inputCount;
  const outputCommitments = publicInputs
    .slice(offset, offset + outputCount)
    .map((entry) => canonicalizeHex(entry ?? ZERO_HEX));
  return { oldRoot, newRoot, nullifiers, outputCommitments };
}

function WalletDrawerContent({ disclosure }: { disclosure: ReturnType<typeof useDisclosure> }) {
  const toast = useToast();
  const { connection } = useConnection();
  const wallet = useWallet();
  const {
    accounts,
    activeAccount,
    viewingId,
    selectAccount,
    createAccount,
    importAccount,
    renameAccount,
    deleteAccount
  } = useLocalWallet();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [privateBalances, setPrivateBalances] = useState<Record<string, string>>({});
  const [transactions, setTransactions] = useState<TransactionEntry[]>([]);
  const [activityLog, setActivityLog] = useState<WalletActivityEntry[]>([]);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [solLamports, setSolLamports] = useState<number>(0);
  const [loadingBalances, setLoadingBalances] = useBoolean(false);
  const [loadingTransactions, setLoadingTransactions] = useBoolean(false);
  const [tokenMetadata, setTokenMetadata] = useState<Record<string, { name: string; symbol: string; image?: string }>>({});
  const [createOpen, setCreateOpen] = useBoolean(false);
  const [importOpen, setImportOpen] = useBoolean(false);
  const [newLabel, setNewLabel] = useState('');
  const [importSecret, setImportSecret] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const sendModal = useDisclosure();
  const [sendContext, setSendContext] = useState<SendAssetContext | null>(null);
  const [isSending, setIsSending] = useState(false);
  const refreshingRef = useRef(false);

  const { mints } = useMintCatalog();

  const mintMap = useMemo(() => {
    const map = new Map<string, { symbol: string; decimals: number }>();
    mints.forEach((mint) => {
      map.set(mint.originMint, { symbol: mint.symbol, decimals: mint.decimals });
      if (mint.zTokenMint) {
        map.set(mint.zTokenMint, { symbol: `z${mint.symbol}`, decimals: mint.decimals });
      }
    });
    return map;
  }, [mints]);

  const [mintDecimalsCache, setMintDecimalsCache] = useState<Record<string, number>>({});

  const indexerClient = useMemo(() => new IndexerClient(), []);
  const proofClient = useMemo(() => new ProofClient(), []);

  const openSendDialog = useCallback(
    (context: SendAssetContext) => {
      setSendContext(context);
      sendModal.onOpen();
    },
    [sendModal]
  );

  const loadPrivateBalances = useCallback(
    async (walletAddress: string) => {
      try {
        const response = await indexerClient.getBalances(walletAddress);
        setPrivateBalances(response?.balances ?? {});
      } catch (error) {
        console.warn('[wallet drawer] failed to load private balances', error);
        setPrivateBalances({});
      }
    },
    [indexerClient]
  );

  const refreshTransactions = useCallback(
    async (showSpinner: boolean) => {
      if (!activeAccount) {
        setTransactions([]);
        if (showSpinner) {
          setLoadingTransactions.off();
        }
        return;
      }

      if (showSpinner) {
        setLoadingTransactions.on();
      }

      try {
        const publicKey = new PublicKey(activeAccount.publicKey);
        const signatureInfos = await connection.getSignaturesForAddress(publicKey, {
          limit: TRANSACTION_LIMIT
        });
        let entries: TransactionEntry[] = [];

        if (signatureInfos.length > 0) {
          const signatures = signatureInfos.map((info) => info.signature);
          const parsedTransactions = await connection.getParsedTransactions(signatures, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });

          entries = signatureInfos.map((info, index) => {
            const parsed = parsedTransactions[index];
            let changeLamports = 0;
            let description = info.err ? 'Failed transaction' : 'No SOL change';
            let tokenTransfers: Array<{
              mint: string;
              symbol: string;
              amount: string;
              decimals: number;
              direction: 'in' | 'out';
            }> = [];
            let fee = 0;

            if (parsed?.meta && parsed.transaction) {
              const accountIndex = parsed.transaction.message.accountKeys.findIndex((key) =>
                key.pubkey.equals(publicKey)
              );
              if (accountIndex !== -1) {
                const pre = parsed.meta.preBalances?.[accountIndex] ?? 0;
                const post = parsed.meta.postBalances?.[accountIndex] ?? 0;
                changeLamports = post - pre;
                if (changeLamports > 0) {
                  description = 'Received SOL';
                } else if (changeLamports < 0) {
                  description = 'Sent SOL';
                }
              }
              
              // Extract transaction fee
              fee = parsed.meta.fee / LAMPORTS_PER_SOL;
              
              // Parse token transfers from inner instructions
              const findMintForAccount = (accountBase58: string): string | null => {
                const keyIndex = parsed.transaction.message.accountKeys.findIndex((key) =>
                  key.pubkey.toBase58() === accountBase58
                );
                if (keyIndex === -1) {
                  return null;
                }
                const balanceEntry =
                  parsed.meta?.preTokenBalances?.find((entry) => entry.accountIndex === keyIndex) ??
                  parsed.meta?.postTokenBalances?.find((entry) => entry.accountIndex === keyIndex);
                return balanceEntry?.mint ?? null;
              };

              parsed.meta.innerInstructions?.forEach((inner) => {
                inner.instructions.forEach((ix) => {
                  if ('parsed' in ix && ix.parsed.type === 'transfer') {
                    const transferInfo = ix.parsed.info;
                    let mintAddress: string | undefined = transferInfo.mint;
                    const amount = Number(transferInfo.amount);
                    const source = transferInfo.source;
                    const destination = transferInfo.destination;

                    if (!mintAddress) {
                      mintAddress = findMintForAccount(source) ?? findMintForAccount(destination) ?? undefined;
                    }

                    if (!mintAddress) {
                      return;
                    }
                    
                    // Get token metadata from mintMap or tokenMetadata
                    const mintMetadata = mintMap.get(mintAddress);
                    const cachedMetadata = tokenMetadata[mintAddress];
                    const decimals = mintMetadata?.decimals ?? mintDecimalsCache[mintAddress] ?? 0;
                    const uiAmount = amount / (10 ** decimals);
                    
                    // Use cached metadata symbol/name if available, otherwise use mintMap or truncated address
                    const symbol = cachedMetadata?.symbol || mintMetadata?.symbol || mintAddress.slice(0, 8);
                    
                    if (source === publicKey.toBase58()) {
                      tokenTransfers.push({ 
                        mint: mintAddress, 
                        symbol, 
                        amount: uiAmount.toFixed(Math.min(6, decimals)), 
                        decimals, 
                        direction: 'out' 
                      });
                    } else if (destination === publicKey.toBase58()) {
                      tokenTransfers.push({ 
                        mint: mintAddress, 
                        symbol, 
                        amount: uiAmount.toFixed(Math.min(6, decimals)), 
                        decimals, 
                        direction: 'in' 
                      });
                    }
                  }
                });
              });
            }

            return {
              signature: info.signature,
              slot: info.slot,
              blockTime: info.blockTime ?? null,
              changeSol: changeLamports / LAMPORTS_PER_SOL,
              description,
              status: info.err ? 'failed' : 'success',
              fee,
              tokenTransfers: tokenTransfers.length > 0 ? tokenTransfers : undefined
            };
          });
        }

        setTransactions(entries);
        console.info('[wallet drawer] refreshed transactions', {
          account: activeAccount.publicKey,
          count: entries.length,
          endpoint: connection.rpcEndpoint
        });
      } catch (error) {
        console.warn('[wallet drawer] Unable to load transactions', error);
        if (showSpinner) {
          toast({
            title: 'Unable to load transactions',
            description: (error as Error).message,
            status: 'error'
          });
        }
      } finally {
        if (showSpinner) {
          setLoadingTransactions.off();
        }
      }
    },
    [activeAccount, connection, setLoadingTransactions, toast, mintMap, tokenMetadata, mintDecimalsCache]
  );

  // Throttle balance fetching to max once every 10 seconds
  const lastBalanceFetchRef = useRef<number>(0);
  const BALANCE_FETCH_THROTTLE_MS = 10_000;

  const refreshBalances = useCallback(
    async (showSpinner: boolean) => {
      if (refreshingRef.current) {
        return;
      }
      
      const now = Date.now();
      const timeSinceLastFetch = now - lastBalanceFetchRef.current;
      
      // If called too soon, skip the actual fetch
      if (timeSinceLastFetch < BALANCE_FETCH_THROTTLE_MS) {
        console.debug('[wallet drawer] Throttling balance fetch', { timeSinceLastFetch, throttleMs: BALANCE_FETCH_THROTTLE_MS });
        if (showSpinner) {
          setLoadingBalances.off();
        }
        return;
      }
      
      lastBalanceFetchRef.current = now;
      refreshingRef.current = true;

      if (!activeAccount) {
        setBalances([]);
        setPrivateBalances({});
        setSolBalance(0);
        if (showSpinner) {
          setLoadingBalances.off();
        }
        refreshingRef.current = false;
        return;
      }

      const publicKey = new PublicKey(activeAccount.publicKey);
      if (showSpinner) {
        setLoadingBalances.on();
      }

      try {
        const [lamports, tokenAccountsLegacy, tokenAccounts2022] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID })
        ]);

        console.info('[wallet drawer] refreshed SOL balance', {
          account: activeAccount.publicKey,
          lamports,
          endpoint: connection.rpcEndpoint
        });
        setSolLamports(lamports);
        setSolBalance(lamports / LAMPORTS_PER_SOL);

        const combinedAccounts = [
          ...tokenAccountsLegacy.value.map((entry) => ({ entry, program: 'token' as const })),
          ...tokenAccounts2022.value.map((entry) => ({ entry, program: 'token2022' as const }))
        ];

        const rows: TokenBalance[] = combinedAccounts
          .map(({ entry, program }) => {
            const info = entry.account.data.parsed.info;
            const mint = info.mint as string;
            const tokenAmount = info.tokenAmount;
            const amount = Number(tokenAmount?.uiAmountString ?? tokenAmount?.uiAmount ?? '0');
            const decimals = Number(tokenAmount?.decimals ?? 0);
            const rawAmount = tokenAmount?.amount ?? '0';
            const metadata = mintMap.get(mint);
            return {
              mint,
              symbol: metadata?.symbol ?? mint.slice(0, 8),
              amount,
              decimals,
              rawAmount,
              program
            };
          })
          .filter((entry) => entry.amount > 0);

        setBalances(rows);
        
        // Fetch metadata for all tokens
        const metadataPromises = rows.map(async (token) => {
          try {
            const mintKey = new PublicKey(token.mint);
            const metadata = await getTokenMetadata(connection, mintKey);
            if (metadata) {
              // Try to fetch image from IPFS URI if available
              let image: string | undefined;
              if (metadata.uri && metadata.uri.startsWith('ipfs://')) {
                const cid = metadata.uri.replace('ipfs://', '');
                // Fetch IPFS metadata to get actual image URL
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
                  // Fallback to URI if IPFS fetch fails
                  image = `https://ipfs.io/ipfs/${cid}`;
                }
              } else if (metadata.uri) {
                image = metadata.uri;
              }
              return { mint: token.mint, metadata: { name: metadata.name, symbol: metadata.symbol, image } };
            }
          } catch (error) {
            console.warn(`[wallet drawer] Failed to fetch metadata for ${token.mint}:`, error);
          }
          return null;
        });
        
        const metadataResults = await Promise.all(metadataPromises);
        const metadataMap: Record<string, { name: string; symbol: string; image?: string }> = {};
        metadataResults.forEach((result) => {
          if (result) {
            metadataMap[result.mint] = result.metadata;
          }
        });
        setTokenMetadata(metadataMap);
        
        // Cache metadata in localStorage for use in convert form
        if (Object.keys(metadataMap).length > 0) {
          const { saveCachedMetadataBatch } = require('../../lib/tokenMetadata/storage');
          saveCachedMetadataBatch(metadataMap);
        }
        
        await loadPrivateBalances(activeAccount.publicKey);
        await refreshTransactions(showSpinner);
      } catch (error) {
        console.error(error);
        if (showSpinner) {
          toast({
            title: 'Unable to load balances',
            description: (error as Error).message,
            status: 'error'
          });
        }
      } finally {
        if (showSpinner) {
          setLoadingBalances.off();
        }
        refreshingRef.current = false;
      }
    },
    [activeAccount, connection, mintMap, refreshTransactions, setLoadingBalances, toast, loadPrivateBalances]
  );

  const sendSolAsset = useCallback(
    async (input: SendAssetInput) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new Error('Wallet not connected');
      }
      const recipientAddress = input.recipient.trim();
      if (!recipientAddress) {
        throw new Error('Enter a recipient address.');
      }
      const amountLamports = parseAmountToBaseUnits(input.amount, 9);
      if (amountLamports <= 0n) {
        throw new Error('Amount must be greater than zero.');
      }
      const available = typeof input.context.availableAmount === 'bigint'
        ? input.context.availableAmount
        : BigInt(input.context.availableAmount);
      if (amountLamports > available) {
        throw new Error('Insufficient SOL balance.');
      }
      const lamportsNumber = Number(amountLamports);
      if (!Number.isSafeInteger(lamportsNumber)) {
        throw new Error('Amount exceeds supported transfer size.');
      }
      const recipientKey = new PublicKey(recipientAddress);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: recipientKey,
          lamports: lamportsNumber
        })
      );
      const memoIx = createMemoInstruction(input.memo);
      if (memoIx) {
        tx.add(memoIx);
      }
      const signature = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, 'confirmed');
      return signature;
    },
    [wallet, connection]
  );

  const sendSplAsset = useCallback(
    async (input: SendAssetInput) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new Error('Wallet not connected');
      }
      if (!input.context.mint) {
        throw new Error('Missing token mint.');
      }
      const program = input.context.program ?? 'token';
      const programId = program === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const recipientAddress = input.recipient.trim();
      if (!recipientAddress) {
        throw new Error('Enter a recipient address.');
      }
      const amountRaw = parseAmountToBaseUnits(input.amount, input.context.decimals);
      if (amountRaw <= 0n) {
        throw new Error('Amount must be greater than zero.');
      }
      const available = typeof input.context.availableAmount === 'bigint'
        ? input.context.availableAmount
        : BigInt(input.context.availableAmount);
      if (amountRaw > available) {
        throw new Error('Insufficient token balance.');
      }
      const owner = wallet.publicKey;
      const mintKey = new PublicKey(input.context.mint);
      const recipientKey = new PublicKey(recipientAddress);
      const sourceAta = await getAssociatedTokenAddress(
        mintKey,
        owner,
        false,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const destinationAta = await getAssociatedTokenAddress(
        mintKey,
        recipientKey,
        false,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const instructions: TransactionInstruction[] = [];
      const destinationInfo = await connection.getAccountInfo(destinationAta);
      if (!destinationInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            owner,
            destinationAta,
            recipientKey,
            mintKey,
            programId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      instructions.push(
        createTransferInstruction(
          sourceAta,
          destinationAta,
          owner,
          amountRaw,
          [],
          programId
        )
      );
      const memoIx = createMemoInstruction(input.memo);
      if (memoIx) {
        instructions.push(memoIx);
      }
      const tx = new Transaction().add(...instructions);
      const signature = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, 'confirmed');
      return signature;
    },
    [wallet, connection]
  );

  const sendShieldedAsset = useCallback(
    async (input: SendAssetInput) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new Error('Wallet not connected');
      }
      if (!activeAccount) {
        throw new Error('Select an account to continue.');
      }
      const targetMint = input.context.mint;
      if (!targetMint) {
        throw new Error('Missing shielded mint.');
      }
      const mintConfig = mints.find(
        (mint) => mint.zTokenMint === targetMint || (!mint.zTokenMint && mint.originMint === targetMint)
      );
      if (!mintConfig || !mintConfig.zTokenMint) {
        throw new Error('This asset is not configured for shielded transfers.');
      }
      const recipientAddress = input.recipient.trim();
      if (!recipientAddress) {
        throw new Error('Enter a recipient address.');
      }
      const amountRaw = parseAmountToBaseUnits(input.amount, input.context.decimals);
      if (amountRaw <= 0n) {
        throw new Error('Amount must be greater than zero.');
      }
      const available =
        typeof input.context.availableAmount === 'bigint'
          ? input.context.availableAmount
          : BigInt(input.context.availableAmount);
      if (amountRaw > available) {
        throw new Error('Insufficient shielded balance.');
      }
      const storedNotes = readStoredNotes();
      const ownerKey = activeAccount.publicKey;
      const candidateNotes = storedNotes
        .filter((note) => (!note.owner || note.owner === ownerKey) && (!note.mint || note.mint === targetMint))
        .map((note) => normaliseStoredNoteAmount(note, input.context.decimals))
        .filter((note): note is StoredNoteWithAmount => Boolean(note));
      if (!candidateNotes.length) {
        throw new Error('No stored shielded notes available for this token.');
      }
      const selection = selectNotesForAmount(candidateNotes, amountRaw);
      if (selection.length > 2) {
        throw new Error('Shielded transfers currently support up to two notes.');
      }
      const totalInput = selection.reduce((sum, note) => sum + BigInt(note.rawAmount), 0n);
      const changeAmount = totalInput - amountRaw;
      if (changeAmount < 0n) {
        throw new Error('Selected notes do not cover the requested amount.');
      }
      const roots = await indexerClient.getRoots(mintConfig.originMint);
      const oldRoot = roots ? canonicalizeHex(roots.current) : null;
      if (!oldRoot) {
        throw new Error('Unable to fetch shielded pool root from indexer.');
      }
      const recipientKey = new PublicKey(recipientAddress);
      const ownerField = pubkeyToFieldString(wallet.publicKey);
      const inputNotes = selection.map((note) => ({
        noteId: note.noteId,
        spendingKey: note.spendingKey,
        amount: note.rawAmount
      }));
      const recipientField = pubkeyToFieldString(recipientKey);
      const recipientBlinding = randomFieldScalar();
      const changeBlinding = changeAmount > 0n ? randomFieldScalar() : 0n;
      const outNotes = [
        {
          amount: amountRaw.toString(),
          recipient: recipientField,
          blinding: recipientBlinding.toString()
        },
        {
          amount: changeAmount.toString(),
          recipient: ownerField,
          blinding: changeAmount > 0n ? changeBlinding.toString() : '0'
        }
      ];
      const payload = {
        oldRoot,
        mintId: mintConfig.originMint,
        poolId: mintConfig.poolId,
        inNotes: inputNotes,
        outNotes
      };
      const proof = await proofClient.requestProof('transfer', payload);
      const parts = parseTransferPublicInputs(proof.publicInputs, inputNotes.length, outNotes.length);
      const amountCommitments = await buildAmountCommitments([
        { amount: amountRaw, blinding: randomFieldScalar() },
        { amount: changeAmount, blinding: changeAmount > 0n ? randomFieldScalar() : 0n }
      ]);
      const signature = await transfer({
        connection,
        wallet,
        originMint: mintConfig.originMint,
        poolId: mintConfig.poolId,
        proof,
        nullifiers: parts.nullifiers,
        outputCommitments: parts.outputCommitments,
        outputAmountCommitments: amountCommitments
      });
      const spentNoteIds = new Set(selection.map((note) => note.id));
      const remainingNotes = readStoredNotes().filter((note) => !spentNoteIds.has(note.id));
      writeStoredNotes(remainingNotes);
      const ownerAddress = wallet.publicKey.toBase58();
      const recipientBase58 = recipientKey.toBase58();
      try {
        await indexerClient.adjustBalance(ownerAddress, targetMint, -amountRaw);
      } catch (error) {
        console.warn('[wallet drawer] failed to decrement owner balance', error);
      }
      try {
        await indexerClient.adjustBalance(recipientBase58, targetMint, amountRaw);
      } catch (error) {
        console.warn('[wallet drawer] failed to increment recipient balance', error);
      }
      if (viewingId) {
        const displayAmount = formatBaseUnitsToUi(amountRaw, input.context.decimals);
        void recordWalletActivity(
          {
            wallet: ownerAddress,
            id: signature,
            signature,
            type: 'transfer',
            symbol: input.context.symbol,
            amount: `-${displayAmount}`,
            timestamp: Date.now()
          },
          { viewId: viewingId }
        );
      }
      return signature;
    },
    [wallet, activeAccount, mints, indexerClient, connection, proofClient, viewingId]
  );

  const handleSendAsset = useCallback(
    async (input: SendAssetInput) => {
      setIsSending(true);
      try {
        let signature: string;
        if (input.context.kind === 'sol') {
          signature = await sendSolAsset(input);
        } else if (input.context.kind === 'spl') {
          signature = await sendSplAsset(input);
        } else if (input.context.kind === 'ztoken') {
          signature = await sendShieldedAsset(input);
        } else {
          throw new Error('Unsupported asset type.');
        }
        toast({
          title: `Sent ${input.amount} ${input.context.symbol}`,
          description: `Signature ${signature}`,
          status: 'success'
        });
        await refreshBalances(false);
        sendModal.onClose();
      } catch (error) {
        toast({
          title: 'Unable to send asset',
          description: (error as Error).message,
          status: 'error'
        });
      } finally {
        setIsSending(false);
      }
    },
    [sendSolAsset, sendSplAsset, sendShieldedAsset, toast, refreshBalances, sendModal]
  );

  useEffect(() => {
    if (!disclosure.isOpen) {
      return;
    }

    let cancelled = false;
    const runRefresh = (showSpinner: boolean) => {
      if (cancelled) {
        return;
      }
      void refreshBalances(showSpinner);
      void refreshTransactions(false); // Refresh transactions periodically
    };

    runRefresh(true);

    const interval = setInterval(() => runRefresh(false), BALANCE_REFRESH_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [disclosure.isOpen, activeAccount, refreshBalances, refreshTransactions]);

  useEffect(() => {
    if (!activeAccount) {
      setPrivateBalances({});
      return;
    }
    void loadPrivateBalances(activeAccount.publicKey);
  }, [activeAccount, loadPrivateBalances]);

  const loadActivity = useCallback(async () => {
    if (!activeAccount) {
      setActivityLog([]);
      return;
    }
    try {
      const entries = await fetchWalletActivity(activeAccount.publicKey, { viewId: viewingId ?? undefined });
      setActivityLog(entries);
    } catch (error) {
      console.warn('[wallet drawer] failed to load conversion activity', error);
    }
  }, [activeAccount, viewingId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    const unsubscribe = subscribeToWalletActivity(() => {
      void loadActivity();
    });
    return () => {
      unsubscribe();
    };
  }, [loadActivity]);

  const renderActivityLabel = (entry: WalletActivityEntry) => {
    if (entry.type === 'wrap') {
      return `Shielded ${entry.amount} ${entry.symbol}`;
    }
    return `Unshielded ${entry.amount} ${entry.symbol}`;
  };

  // Fetch decimals for mints not in catalog
  useEffect(() => {
    const fetchMissingDecimals = async () => {
      const missing: string[] = [];
      Object.keys(privateBalances).forEach((mint) => {
        if (!mintMap.has(mint) && !mintDecimalsCache[mint]) {
          missing.push(mint);
        }
      });
      
      if (missing.length === 0 || !connection) return;
      
      const decimalsPromises = missing.map(async (mintAddress) => {
        try {
          const mintKey = new PublicKey(mintAddress);
          // Try TOKEN_PROGRAM_ID first
          try {
            const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_PROGRAM_ID);
            return { mint: mintAddress, decimals: mintInfo.decimals };
          } catch {
            // Try TOKEN_2022_PROGRAM_ID
            try {
              const mintInfo = await getMint(connection, mintKey, undefined, TOKEN_2022_PROGRAM_ID);
              return { mint: mintAddress, decimals: mintInfo.decimals };
            } catch {
              return { mint: mintAddress, decimals: 0 };
            }
          }
        } catch {
          return { mint: mintAddress, decimals: 0 };
        }
      });
      
      const results = await Promise.all(decimalsPromises);
      setMintDecimalsCache((prev) => {
        const updated = { ...prev };
        results.forEach(({ mint, decimals }) => {
          updated[mint] = decimals;
        });
        return updated;
      });
    };
    
    void fetchMissingDecimals();
  }, [privateBalances, mintMap, connection, mintDecimalsCache]);

  const privateBalanceEntries = useMemo(() => {
    return Object.entries(privateBalances)
      .map(([mint, amountString]) => {
        let amount = 0n;
        try {
          amount = BigInt(amountString);
        } catch {
          amount = 0n;
        }
        if (amount === 0n) {
          return null;
        }
        const metadata = mintMap.get(mint);
        // Use catalog decimals if available, otherwise use cached decimals from chain, otherwise default to 0
        const decimals = metadata?.decimals ?? mintDecimalsCache[mint] ?? 0;
        const baseSymbol = metadata?.symbol?.replace(/^z/, '') ?? mint.slice(0, 6);
        const symbol = `z${baseSymbol}`;
        const formatted = formatBaseUnitsToUi(amount, decimals);
        return {
          mint,
          symbol,
          formatted,
          decimals,
          amount
        };
      })
      .filter(
        (entry): entry is { mint: string; symbol: string; formatted: string; decimals: number; amount: bigint } =>
          Boolean(entry)
      );
  }, [mintMap, privateBalances, mintDecimalsCache]);
  const canSendShielded = Boolean(viewingId);

  const handleCreateAccount = () => {
    createAccount(newLabel.trim() || undefined);
    setNewLabel('');
    setCreateOpen.off();
  };

  const handleImportAccount = () => {
    try {
      importAccount(importSecret.trim(), importLabel.trim() || undefined);
      setImportSecret('');
      setImportLabel('');
      setImportOpen.off();
    } catch (error) {
      toast({
        title: 'Unable to import account',
        description: (error as Error).message,
        status: 'error'
      });
    }
  };

  return (
    <>
      <Drawer isOpen={disclosure.isOpen} placement="right" size="sm" onClose={disclosure.onClose}>
        <DrawerOverlay />
        <DrawerContent bg="rgba(18, 16, 14, 0.96)" borderLeft="1px solid rgba(245,178,27,0.24)">
          <DrawerCloseButton />
          <DrawerHeader borderBottomWidth="1px" borderColor="whiteAlpha.200">
          <Stack spacing={2}>
            <Text fontSize="sm" color="whiteAlpha.600">
              Connected wallet
            </Text>
            <HStack spacing={3}>
              <Badge colorScheme="brand" variant="subtle">
                Devnet
              </Badge>
              {activeAccount && (
                <HStack spacing={2}>
                  <Text fontWeight="medium" color="whiteAlpha.800">
                    {activeAccount.label} · {formatAddress(activeAccount.publicKey)}
                  </Text>
                  <CopyAddressButton value={activeAccount.publicKey} ariaLabel="Copy active account address" />
                </HStack>
              )}
            </HStack>
          </Stack>
        </DrawerHeader>

        <DrawerBody py={6}>
          <Stack spacing={8}>
            <Stack spacing={3}>
              <Text fontSize="sm" color="whiteAlpha.600" textTransform="uppercase" letterSpacing="0.08em">
                Balances
              </Text>
              <Box
                border="1px solid rgba(245,178,27,0.2)"
                rounded="2xl"
                p={5}
                bg="rgba(20, 18, 14, 0.82)"
                boxShadow="0 0 25px rgba(245, 178, 27, 0.18)"
              >
                {loadingBalances ? (
                  <Flex align="center" justify="center" py={8}>
                    <Spinner />
                  </Flex>
                ) : (
                  <Stack spacing={4}>
                    <Flex align="center" justify="space-between" gap={4} wrap="wrap">
                      <Stack spacing={1}>
                        <Text color="whiteAlpha.700" fontSize="sm">
                          SOL
                        </Text>
                        <Text fontSize="2xl" fontWeight="semibold">
                          {solBalance.toLocaleString()}
                        </Text>
                      </Stack>
                      <Button
                        size="sm"
                        colorScheme="brand"
                        variant="outline"
                        onClick={() =>
                          openSendDialog({
                            kind: 'sol',
                            mint: null,
                            symbol: 'SOL',
                            decimals: 9,
                            availableDisplay: `${solBalance.toLocaleString()} SOL`,
                            availableUiAmount: solBalance.toString(),
                            availableAmount: BigInt(solLamports),
                            isPrivate: false
                          })
                        }
                        isDisabled={!activeAccount}
                      >
                        Send
                      </Button>
                    </Flex>
                    <SimpleGrid columns={1} spacing={3}>
                      {balances.map((token) => {
                        const metadata = tokenMetadata[token.mint];
                        const displayName = metadata?.name ?? token.symbol;
                        const displaySymbol = metadata?.symbol ?? token.symbol;
                        return (
                          <Flex key={token.mint} align="center" justify="space-between" gap={3} wrap="wrap">
                            <HStack spacing={2} flex={1}>
                              {metadata?.image && (
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
                                    src={metadata.image}
                                    alt={displayName}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    onError={(e) => {
                                      // Hide image on error
                                      (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                </Box>
                              )}
                              <Stack spacing={0} flex={1} minW={0}>
                                <HStack spacing={1}>
                                  <Text fontWeight="medium" color="whiteAlpha.800" isTruncated>
                                    {displayName}
                                  </Text>
                                  {displaySymbol !== displayName && (
                                    <Text fontSize="xs" color="whiteAlpha.500">
                                      ({displaySymbol})
                                    </Text>
                                  )}
                                </HStack>
                                <HStack spacing={1} align="center">
                                  <Tooltip label="Click to copy full mint address">
                                    <Text 
                                      fontSize="xs" 
                                      color="whiteAlpha.500" 
                                      isTruncated
                                      cursor="pointer"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                          navigator.clipboard.writeText(token.mint).catch(() => undefined);
                                          toast({
                                            title: 'Mint address copied',
                                            status: 'success',
                                            duration: 1500,
                                            isClosable: true
                                          });
                                        }
                                      }}
                                      _hover={{ color: 'whiteAlpha.700' }}
                                    >
                                      {formatAddress(token.mint)}
                                    </Text>
                                  </Tooltip>
                                  <CopyAddressButton
                                    value={token.mint}
                                    ariaLabel="Copy mint address"
                                    stopPropagation
                                  />
                                </HStack>
                              </Stack>
                            </HStack>
                          <HStack spacing={2}>
                            <Text fontWeight="semibold" color="whiteAlpha.900">
                              {token.amount.toLocaleString(undefined, {
                                minimumFractionDigits: 0,
                                maximumFractionDigits: Math.min(6, token.decimals)
                              })}
                            </Text>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                openSendDialog({
                                  kind: 'spl',
                                  mint: token.mint,
                                  symbol: token.symbol,
                                  decimals: token.decimals,
                                  availableDisplay: `${token.amount.toLocaleString()} ${token.symbol}`,
                                  availableUiAmount: token.amount.toString(),
                                  availableAmount: (() => {
                                    try {
                                      return BigInt(token.rawAmount);
                                    } catch {
                                      return BigInt(0);
                                    }
                                  })(),
                                  isPrivate: false,
                                  program: token.program
                                })
                              }
                              isDisabled={!activeAccount}
                            >
                              Send
                            </Button>
                          </HStack>
                        </Flex>
                        );
                      })}
                    </SimpleGrid>
                    {privateBalanceEntries.length > 0 && (
                      <Stack spacing={2}>
                        <Text fontSize="sm" color="whiteAlpha.500">
                          Shielded balances
                        </Text>
                        <SimpleGrid columns={1} spacing={3}>
                          {privateBalanceEntries.map((entry) => {
                            const metadata = tokenMetadata[entry.mint];
                            const displayName = metadata?.name ? `z${metadata.name}` : entry.symbol;
                            const displaySymbol = metadata?.symbol ? `z${metadata.symbol}` : entry.symbol;
                            return (
                              <Flex key={`private-${entry.mint}`} align="center" justify="space-between" gap={3} wrap="wrap">
                                <HStack spacing={2} flex={1}>
                                  {metadata?.image && (
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
                                        src={metadata.image}
                                        alt={displayName}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                        onError={(e) => {
                                          (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                      />
                                    </Box>
                                  )}
                                  <Stack spacing={0} flex={1} minW={0}>
                                    <HStack spacing={1}>
                                      <Text fontWeight="medium" color="whiteAlpha.800" isTruncated>
                                        {displayName}
                                      </Text>
                                      {displaySymbol !== displayName && (
                                        <Text fontSize="xs" color="whiteAlpha.500">
                                          ({displaySymbol})
                                        </Text>
                                      )}
                                    </HStack>
                                    <HStack spacing={1} align="center">
                                      <Tooltip label="Click to copy full mint address">
                                        <Text 
                                          fontSize="xs" 
                                          color="whiteAlpha.500" 
                                          isTruncated
                                          cursor="pointer"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                              navigator.clipboard.writeText(entry.mint).catch(() => undefined);
                                              toast({
                                                title: 'Mint address copied',
                                                status: 'success',
                                                duration: 1500,
                                                isClosable: true
                                              });
                                            }
                                          }}
                                          _hover={{ color: 'whiteAlpha.700' }}
                                        >
                                          {formatAddress(entry.mint)}
                                        </Text>
                                      </Tooltip>
                                      <CopyAddressButton
                                        value={entry.mint}
                                        ariaLabel="Copy mint address"
                                        stopPropagation
                                      />
                                    </HStack>
                                  </Stack>
                                </HStack>
                              <HStack spacing={2}>
                                <Text fontWeight="semibold" color="whiteAlpha.900">
                                  {entry.formatted}
                                </Text>
                                <Tooltip
                                  label="Shielded transfers require a viewing key"
                                  isDisabled={canSendShielded}
                                >
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() =>
                                      openSendDialog({
                                        kind: 'ztoken',
                                        mint: entry.mint,
                                        symbol: entry.symbol,
                                        decimals: entry.decimals,
                                        availableDisplay: `${entry.formatted}`,
                                        availableUiAmount: entry.formatted,
                                        availableAmount: entry.amount,
                                        isPrivate: true
                                      })
                                    }
                                    isDisabled={!activeAccount || !canSendShielded}
                                  >
                                    Send
                                  </Button>
                                </Tooltip>
                              </HStack>
                            </Flex>
                            );
                          })}
                        </SimpleGrid>
                      </Stack>
                    )}
                    {balances.length === 0 && privateBalanceEntries.length === 0 && (
                      <Text fontSize="sm" color="whiteAlpha.500">
                        No balances found for this account.
                      </Text>
                    )}
                  </Stack>
                )}
              </Box>
            </Stack>

            <Stack spacing={3}>
              <Flex align="center" justify="space-between">
                <Text fontSize="sm" color="whiteAlpha.600" textTransform="uppercase" letterSpacing="0.08em">
                  Accounts
                </Text>
                <Menu>
                  <MenuButton as={IconButton} icon={<Icon as={Plus} />} variant="ghost" aria-label="Manage accounts" />
                  <MenuList>
                    <MenuItem icon={<Icon as={Plus} />} onClick={setCreateOpen.on}>
                      Create new account
                    </MenuItem>
                    <MenuItem icon={<Icon as={Coins} />} onClick={setImportOpen.on}>
                      Import secret key
                    </MenuItem>
                  </MenuList>
                </Menu>
              </Flex>

              <Stack spacing={3}>
                {accounts.map((account) => (
                  <Flex
                    key={account.id}
                    px={4}
                    py={3}
                    rounded="xl"
                    border="1px solid"
                    borderColor={account.id === activeAccount?.id ? 'brand.300' : 'whiteAlpha.200'}
                    align="center"
                    justify="space-between"
                    bg={account.id === activeAccount?.id ? 'whiteAlpha.100' : 'transparent'}
                    transition="all 0.2s"
                    _hover={{ borderColor: 'brand.200', cursor: 'pointer' }}
                    onClick={() => selectAccount(account.id)}
                  >
                    <Stack spacing={1}>
                      <Editable
                        defaultValue={account.label}
                        fontWeight="semibold"
                        color="whiteAlpha.900"
                        onSubmit={(next) => renameAccount(account.id, next || account.label)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <EditablePreview />
                        <EditableInput />
                      </Editable>
                      <HStack spacing={2} color="whiteAlpha.500" fontSize="xs">
                        <Text>{formatAddress(account.publicKey)}</Text>
                        <CopyAddressButton
                          value={account.publicKey}
                          ariaLabel="Copy account address"
                          stopPropagation
                        />
                      </HStack>
                    </Stack>
                    <IconButton
                      icon={<Icon as={Trash2} fontSize="sm" />}
                      aria-label="Delete account"
                      variant="ghost"
                      size="sm"
                      isDisabled={accounts.length === 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (accounts.length === 1) return;
                        deleteAccount(account.id);
                      }}
                    />
                  </Flex>
                ))}
              </Stack>

              {createOpen && (
                <Box border="1px dashed" borderColor="brand.400" rounded="lg" p={4}>
                  <Stack spacing={2}>
                    <Text fontSize="sm" color="whiteAlpha.700">
                      New account label
                    </Text>
                    <Input placeholder="Account label" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
                    <Button size="sm" onClick={handleCreateAccount}>
                      Create account
                    </Button>
                  </Stack>
                </Box>
              )}

              {importOpen && (
                <Box border="1px dashed" borderColor="brand.400" rounded="lg" p={4}>
                  <Stack spacing={2}>
                    <Text fontSize="sm" color="whiteAlpha.700">
                      Paste a base58-encoded secret key to import an existing account.
                    </Text>
                    <Input
                      placeholder="Secret key"
                      value={importSecret}
                      onChange={(event) => setImportSecret(event.target.value)}
                    />
                    <Input
                      placeholder="Label (optional)"
                      value={importLabel}
                      onChange={(event) => setImportLabel(event.target.value)}
                    />
                    <Button size="sm" onClick={handleImportAccount}>
                      Import account
                    </Button>
                  </Stack>
                </Box>
              )}
            </Stack>

            <Stack spacing={3}>
              <Text fontSize="sm" color="whiteAlpha.600" textTransform="uppercase" letterSpacing="0.08em">
                Recent activity
              </Text>
                <Box
                  border="1px solid rgba(245,178,27,0.2)"
                  rounded="2xl"
                  p={5}
                  bg="rgba(20, 18, 14, 0.82)"
                  boxShadow="0 0 25px rgba(245, 178, 27, 0.18)"
                >
                {loadingTransactions ? (
                  <Flex align="center" justify="center" py={8}>
                    <Spinner />
                  </Flex>
                ) : (() => {
                  // Merge activityLog with transactions and filter
                  const MIN_SOL_THRESHOLD = 0.001; // Filter out tiny SOL transactions (< 0.001 SOL)
                  
                  // Create map of transactions by signature
                  const txMap = new Map<string, TransactionEntry>();
                  transactions.forEach((tx) => {
                    txMap.set(tx.signature, tx);
                  });
                  
                  // Create unified activity list starting with activityLog entries
                  const unified: UnifiedActivityEntry[] = [];
                  
                  // Add conversions from activity log (even if transaction not found yet)
                  activityLog.forEach((activity) => {
                    const tx = txMap.get(activity.signature);
                    unified.push({
                      signature: activity.signature,
                      timestamp: activity.timestamp,
                      type: activity.type === 'wrap' ? 'wrap' : activity.type === 'unwrap' ? 'unwrap' : 'transfer',
                      description: activity.type === 'wrap' 
                        ? `Shielded ${activity.amount} ${activity.symbol}`
                        : activity.type === 'unwrap'
                        ? `Unshielded ${activity.amount} ${activity.symbol}`
                        : `Transferred ${activity.amount} ${activity.symbol}`,
                      status: tx?.status ?? 'success',
                      solChange: tx?.changeSol,
                      fee: tx?.fee,
                      tokenTransfers: tx?.tokenTransfers
                    });
                  });
                  
                  // Add transactions that aren't already in activity log
                  transactions.forEach((tx) => {
                    // Skip if already added from activity log
                    if (activityLog.some(a => a.signature === tx.signature)) {
                      return;
                    }
                    
                    // Skip tiny SOL-only transactions (likely just gas fees)
                    const isTinySolOnly = Math.abs(tx.changeSol) < MIN_SOL_THRESHOLD && 
                                        !tx.tokenTransfers;
                    if (isTinySolOnly) {
                      return; // Skip this transaction
                    }
                    
                    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
                      // Token transfer
                      const transfer = tx.tokenTransfers[0];
                      unified.push({
                        signature: tx.signature,
                        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                        type: 'token',
                        description: transfer.direction === 'in'
                          ? `Received ${transfer.amount} ${transfer.symbol}`
                          : `Sent ${transfer.amount} ${transfer.symbol}`,
                        status: tx.status,
                        solChange: tx.changeSol,
                        fee: tx.fee,
                        tokenTransfers: tx.tokenTransfers
                      });
                    } else if (Math.abs(tx.changeSol) >= MIN_SOL_THRESHOLD) {
                      // Significant SOL transfer
                      unified.push({
                        signature: tx.signature,
                        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
                        type: 'sol',
                        description: tx.description,
                        status: tx.status,
                        solChange: tx.changeSol,
                        fee: tx.fee
                      });
                    }
                  });
                  
                  // Sort by timestamp (newest first)
                  unified.sort((a, b) => b.timestamp - a.timestamp);
                  
                  if (unified.length === 0) {
                    return (
                      <Text fontSize="sm" color="whiteAlpha.500">
                        No recent transactions.
                      </Text>
                    );
                  }
                  
                  return (
                    <Stack spacing={3}>
                      {unified.map((entry) => {
                        const solChange = entry.solChange && Math.abs(entry.solChange) >= 1e-9 
                          ? `${entry.solChange > 0 ? '+' : ''}${entry.solChange.toFixed(6)} SOL`
                          : null;
                        const feeDisplay = entry.fee && entry.fee > 0 
                          ? `Gas: ${entry.fee.toFixed(6)} SOL`
                          : null;

                        return (
                          <Box
                            key={entry.signature}
                            bg="rgba(24, 20, 16, 0.9)"
                            border="1px solid rgba(245,178,27,0.2)"
                            rounded="lg"
                            p={3}
                          >
                            <Flex justify="space-between" align="center" mb={1}>
                              <Text fontWeight="semibold" color="whiteAlpha.800">
                                {entry.description}
                              </Text>
                              <Text
                                fontSize="xs"
                                color={entry.status === 'success' ? 'green.300' : 'red.300'}
                              >
                                {entry.status === 'success' ? 'Success' : 'Failed'}
                              </Text>
                            </Flex>
                            <VStack spacing={1} align="stretch">
                              {entry.tokenTransfers && entry.tokenTransfers.length > 0 && (
                                <Text fontSize="sm" color="whiteAlpha.700">
                                  {entry.tokenTransfers.map((t, i) => (
                                    <span key={i}>
                                      {t.direction === 'in' ? 'Received' : 'Sent'} {t.amount} {t.symbol}
                                      {i < entry.tokenTransfers!.length - 1 ? ', ' : ''}
                                    </span>
                                  ))}
                                </Text>
                              )}
                              {solChange && (
                                <Text fontSize="sm" color="whiteAlpha.700">
                                  {solChange}
                                </Text>
                              )}
                              {feeDisplay && (
                                <Text fontSize="xs" color="whiteAlpha.500">
                                  {feeDisplay}
                                </Text>
                              )}
                            </VStack>
                            <Text fontSize="xs" color="whiteAlpha.500" mt={2}>
                              {new Date(entry.timestamp).toLocaleString()}
                            </Text>
                            <HStack spacing={2} mt={1} align="center">
                              <Code fontSize="xs" wordBreak="break-all">
                                {entry.signature}
                              </Code>
                              <Tooltip label="Copy signature">
                                <IconButton
                                  aria-label="Copy signature"
                                  icon={<Copy size={14} />}
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(entry.signature);
                                    toast({
                                      title: 'Signature copied',
                                      status: 'success',
                                      duration: 1500,
                                      isClosable: true
                                    });
                                  }}
                                />
                              </Tooltip>
                            </HStack>
                          </Box>
                        );
                      })}
                    </Stack>
                  );
                })()}
                </Box>
              </Stack>
            </Stack>
          </DrawerBody>
          <DrawerFooter borderTopWidth="1px" borderColor="whiteAlpha.200">
            <Text fontSize="xs" color="whiteAlpha.500">
              Managed wallet keys are stored locally on this device for the private devnet only.
            </Text>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <SendAssetModal
        isOpen={sendModal.isOpen}
        onClose={sendModal.onClose}
        context={sendContext}
        viewingId={viewingId}
        onSubmit={handleSendAsset}
        isSubmitting={isSending}
      />
    </>
  );
}

interface SendAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  context: SendAssetContext | null;
  viewingId: string | null;
  onSubmit: (input: SendAssetInput) => Promise<void>;
  isSubmitting: boolean;
}

function SendAssetModal({ isOpen, onClose, context, viewingId, onSubmit, isSubmitting }: SendAssetModalProps) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setRecipient('');
      setAmount('');
      setMemo('');
    }
  }, [isOpen, context]);

  if (!context) {
    return null;
  }

  const isShieldedBlocked = context.isPrivate && !viewingId;
  const disableSubmit = !recipient || !amount || isShieldedBlocked || isSubmitting;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" isCentered>
      <ModalOverlay />
      <ModalContent bg="rgba(18,16,14,0.98)" border="1px solid rgba(245,178,27,0.24)">
        <ModalHeader>Send {context.symbol}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Stack spacing={4}>
            <Text fontSize="sm" color="whiteAlpha.600">
              Available: {context.availableDisplay}
            </Text>
            <FormControl>
              <FormLabel>Recipient</FormLabel>
              <Input
                placeholder="Enter Solana address"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Amount</FormLabel>
              <InputGroup>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <InputRightElement width="auto" pr={3}>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setAmount(context.availableUiAmount)}
                  >
                    Max
                  </Button>
                </InputRightElement>
              </InputGroup>
            </FormControl>
            <FormControl>
              <FormLabel>Memo (optional)</FormLabel>
              <Textarea
                placeholder="Add a note for your records"
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                resize="vertical"
              />
            </FormControl>
            {isShieldedBlocked && (
              <Alert status="warning" variant="left-accent">
                <AlertIcon />
                <AlertDescription fontSize="sm">
                  Shielded transfers require a viewing key. Please switch to a locally managed wallet with a derived
                  viewing key.
                </AlertDescription>
              </Alert>
            )}
          </Stack>
        </ModalBody>
        <ModalFooter gap={3}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            colorScheme="brand"
            onClick={() => onSubmit({ recipient, amount, memo: memo || undefined, context })}
            isDisabled={disableSubmit}
            isLoading={isSubmitting}
          >
            Send
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

