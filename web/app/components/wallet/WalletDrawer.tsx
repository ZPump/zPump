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
  Textarea,
  Tooltip,
  useBoolean,
  useClipboard,
  useDisclosure,
  useToast
} from '@chakra-ui/react';
import { useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Coins, Copy, Plus, Trash2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalWallet } from './LocalWalletContext';
import { formatBaseUnitsToUi } from '../../lib/format';
import { IndexerClient } from '../../lib/indexerClient';
import { useMintCatalog } from '../providers/MintCatalogProvider';
import {
  fetchWalletActivity,
  subscribeToWalletActivity,
  WalletActivityEntry
} from '../../lib/client/activityLog';

interface TokenBalance {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  rawAmount: string;
}

interface TransactionEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  changeSol: number;
  description: string;
  status: 'success' | 'failed';
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

function WalletDrawerContent({ disclosure }: { disclosure: ReturnType<typeof useDisclosure> }) {
  const toast = useToast();
  const { connection } = useConnection();
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

  const indexerClient = useMemo(() => new IndexerClient(), []);

  const openSendDialog = useCallback(
    (context: SendAssetContext) => {
      setSendContext(context);
      sendModal.onOpen();
    },
    [sendModal]
  );

  const handleSendAsset = useCallback(
    async (input: SendAssetInput) => {
      setIsSending(true);
      try {
        console.info('[wallet drawer] send asset request', input);
        toast({
          title: 'Send flow coming soon',
          description: 'Shielded transfers will be wired up after the SDK update.',
          status: 'info'
        });
      } catch (error) {
        toast({
          title: 'Unable to send asset',
          description: (error as Error).message,
          status: 'error'
        });
      } finally {
        setIsSending(false);
        sendModal.onClose();
      }
    },
    [sendModal, toast]
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
            }

            return {
              signature: info.signature,
              slot: info.slot,
              blockTime: info.blockTime ?? null,
              changeSol: changeLamports / LAMPORTS_PER_SOL,
              description,
              status: info.err ? 'failed' : 'success'
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
    [activeAccount, connection, setLoadingTransactions, toast]
  );

  const refreshBalances = useCallback(
    async (showSpinner: boolean) => {
      if (refreshingRef.current) {
        return;
      }
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

        const combinedAccounts = [...tokenAccountsLegacy.value, ...tokenAccounts2022.value];

        const rows: TokenBalance[] = combinedAccounts
          .map((entry) => {
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
              rawAmount
            };
          })
          .filter((entry) => entry.amount > 0);

        setBalances(rows);
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
    };

    runRefresh(true);

    const interval = setInterval(() => runRefresh(false), BALANCE_REFRESH_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [disclosure.isOpen, activeAccount, refreshBalances]);

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
        const decimals = metadata?.decimals ?? 0;
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
  }, [mintMap, privateBalances]);
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
      <Drawer isOpen placement="right" size="sm" onClose={disclosure.onClose}>
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
            <Stack spacing={4}>
            {activityLog.length > 0 && (
              <Stack spacing={3}>
                <Flex align="center" justify="space-between">
                  <Text fontSize="sm" color="whiteAlpha.600" textTransform="uppercase" letterSpacing="0.08em">
                    Conversion activity
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    colorScheme="brand"
                    onClick={() => {
                      void loadActivity();
                    }}
                  >
                    Refresh
                  </Button>
                </Flex>
                <Stack spacing={2}>
                  {activityLog.map((entry) => (
                    <Box
                      key={entry.id}
                      bg="rgba(255,255,255,0.02)"
                      border="1px solid rgba(255,255,255,0.08)"
                      rounded="lg"
                      p={3}
                    >
                      <Flex justify="space-between" align="center">
                        <Text fontSize="sm" fontWeight="semibold" color="whiteAlpha.900">
                          {renderActivityLabel(entry)}
                        </Text>
                        <Text fontSize="xs" color="whiteAlpha.500">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </Text>
                      </Flex>
                      <HStack spacing={2} mt={2} align="center">
                        <Code fontSize="xs" colorScheme="yellow">
                          {entry.signature.slice(0, 8)}…{entry.signature.slice(-6)}
                        </Code>
                        <Tooltip label="Copy signature">
                          <IconButton
                            aria-label="Copy signature"
                            icon={<Icon as={Copy} boxSize={3} />}
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                navigator.clipboard.writeText(entry.signature).catch(() => undefined);
                              }
                            }}
                          />
                        </Tooltip>
                      </HStack>
                    </Box>
                  ))}
                </Stack>
              </Stack>
            )}
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
                      {balances.map((token) => (
                        <Flex key={token.mint} align="center" justify="space-between" gap={3} wrap="wrap">
                          <Stack spacing={0}>
                            <Text fontWeight="medium" color="whiteAlpha.800">
                              {token.symbol}
                            </Text>
                            <Text fontSize="xs" color="whiteAlpha.500">
                              {formatAddress(token.mint)}
                            </Text>
                          </Stack>
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
                                  isPrivate: false
                                })
                              }
                              isDisabled={!activeAccount}
                            >
                              Send
                            </Button>
                          </HStack>
                        </Flex>
                      ))}
                    </SimpleGrid>
                    {privateBalanceEntries.length > 0 && (
                      <Stack spacing={2}>
                        <Text fontSize="sm" color="whiteAlpha.500">
                          Shielded balances
                        </Text>
                        <SimpleGrid columns={1} spacing={3}>
                          {privateBalanceEntries.map((entry) => (
                            <Flex key={`private-${entry.mint}`} align="center" justify="space-between" gap={3} wrap="wrap">
                              <Stack spacing={0}>
                                <Text fontWeight="medium" color="whiteAlpha.800">
                                  {entry.symbol}
                                </Text>
                                <Text fontSize="xs" color="whiteAlpha.500">
                                  {formatAddress(entry.mint)}
                                </Text>
                              </Stack>
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
                          ))}
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
                ) : transactions.length === 0 ? (
                  <Text fontSize="sm" color="whiteAlpha.500">
                    No recent transactions.
                  </Text>
                ) : (
                  <Stack spacing={3}>
                    {transactions.map((entry) => {
                      const solChange = Math.abs(entry.changeSol) < 1e-9 ? null : `${
                        entry.changeSol > 0 ? '+' : ''
                      }${entry.changeSol.toFixed(6)} SOL`;

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
                          {solChange && (
                            <Text fontSize="sm" color="whiteAlpha.700">
                              {solChange}
                            </Text>
                          )}
                          <Text fontSize="xs" color="whiteAlpha.500">
                            {entry.blockTime
                              ? new Date(entry.blockTime * 1000).toLocaleString()
                              : `Slot ${entry.slot}`}
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
                )}
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

