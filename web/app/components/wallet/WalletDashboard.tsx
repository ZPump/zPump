'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Code,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  GridItem,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  NumberInput,
  NumberInputField,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Table,
  Tbody,
  Td,
  Text,
  Tr,
  useClipboard,
  useToast
} from '@chakra-ui/react';
import { chakra } from '@chakra-ui/react';
import { Plus, Copy, Download, Wallet, MoreHorizontal, Send } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { useSimulation } from '../../hooks/useSimulation';
import { SimAccount, SimTransaction } from '../../lib/simulation/types';
import { SOL_TOKEN_ID } from '../../lib/simulation/constants';

function formatAmount(value: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }
  if (parsed === 0) {
    return '0';
  }
  if (parsed >= 1) {
    return parsed.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return parsed.toPrecision(4);
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { hour12: false });
}

function getBalance(account: SimAccount | null, tokenId: string): number {
  if (!account) {
    return 0;
  }
  return Number.parseFloat(account.balances[tokenId] ?? '0') || 0;
}

function AccountTile({
  account,
  isActive,
  onActivate,
  onRename,
  onRemove,
  onExport
}: {
  account: SimAccount;
  isActive: boolean;
  onActivate: () => void;
  onRename: (nextLabel: string) => void;
  onRemove: () => void;
  onExport: () => void;
}) {
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [isRenaming, setRenaming] = useState(false);
  const { onCopy, hasCopied } = useClipboard(account.publicKey);

  return (
    <Stack
      spacing={3}
      bg={isActive ? 'rgba(59,205,255,0.18)' : 'rgba(4, 8, 20, 0.95)'}
      border="1px solid rgba(59,205,255,0.25)"
      rounded="2xl"
      p={4}
      boxShadow={isActive ? '0 0 30px rgba(59,205,255,0.32)' : '0 0 18px rgba(59,205,255,0.12)'}
    >
      <HStack justify="space-between" align="start">
        <Stack spacing={2} flex="1">
          {isRenaming ? (
            <Input
              size="sm"
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (labelDraft.trim() && labelDraft.trim() !== account.label) {
                  onRename(labelDraft.trim());
                }
              }}
              autoFocus
            />
          ) : (
            <Text fontWeight="semibold">{account.label}</Text>
          )}
          <Code fontSize="xs">{account.publicKey}</Code>
          <Text fontSize="xs" color="whiteAlpha.500">
            Created {new Date(account.createdAt).toLocaleString()}
          </Text>
        </Stack>
        <Stack direction="row" spacing={2}>
          <IconButton
            aria-label="Copy address"
            icon={<Copy size={16} />}
            size="sm"
            variant="ghost"
            onClick={onCopy}
          />
          <IconButton
            aria-label="Export account secret"
            icon={<Download size={16} />}
            size="sm"
            variant="ghost"
            onClick={onExport}
          />
        </Stack>
      </HStack>
      <HStack spacing={2}>
        <Button
          size="sm"
          variant={isActive ? 'solid' : 'outline'}
          colorScheme={isActive ? 'cyan' : undefined}
          leftIcon={<Wallet size={14} />}
          onClick={onActivate}
        >
          {isActive ? 'Active' : 'Activate'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRenaming(true)}
        >
          Rename
        </Button>
        <Button size="sm" variant="ghost" colorScheme="red" onClick={onRemove}>
          Remove
        </Button>
      </HStack>
      <Button size="xs" variant="link" onClick={onCopy} alignSelf="flex-start" color="whiteAlpha.600">
        {hasCopied ? 'Address copied' : 'Copy address'}
      </Button>
    </Stack>
  );
}

function AccountManager() {
  const toast = useToast();
  const {
    state,
    activeAccount,
    setActiveAccount,
    createAccount,
    renameAccount,
    deleteAccount,
    exportAccount,
    importAccount
  } = useSimulation();
  const [newLabel, setNewLabel] = useState('');
  const [importPayload, setImportPayload] = useState('');

  const handleCreate = () => {
    const account = createAccount(newLabel || undefined);
    toast({
      title: 'Simulation account created',
      description: `${account.publicKey.slice(0, 4)}…${account.publicKey.slice(-4)} is ready.`,
      status: 'success',
      duration: 3000,
      isClosable: true
    });
    setNewLabel('');
  };

  const handleExport = (accountId: string) => {
    const payload = exportAccount(accountId);
    if (!payload) {
      return;
    }
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      toast({
        title: 'Secret copied',
        description: 'Paste this JSON in another browser to import the account.',
        status: 'info',
        duration: 4000,
        isClosable: true
      });
    });
  };

  const handleImport = () => {
    try {
      let secret = importPayload.trim();
      let label: string | undefined;
      if (!secret) {
        toast({ title: 'Paste a secret key or JSON export', status: 'error' });
        return;
      }
      if (secret.startsWith('{')) {
        const parsed = JSON.parse(secret) as { secretKey: string; label?: string };
        if (!parsed.secretKey) {
          throw new Error('Missing secretKey field');
        }
        secret = parsed.secretKey;
        label = parsed.label;
      }
      const account = importAccount(secret, label);
      toast({
        title: 'Account imported',
        description: `${account.publicKey.slice(0, 4)}…${account.publicKey.slice(-4)} is now available.`,
        status: 'success',
        duration: 4000,
        isClosable: true
      });
      setImportPayload('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to parse secret.';
      toast({ title: 'Import failed', description: message, status: 'error' });
    }
  };

  return (
    <Stack spacing={4}>
      <HStack justify="space-between">
        <Heading size="md">Simulation accounts</Heading>
        <Menu>
          <MenuButton as={IconButton} icon={<MoreHorizontal size={18} />} variant="ghost" aria-label="Account menu" />
          <MenuList>
            <MenuItem icon={<Plus size={16} />} onClick={handleCreate}>
              New account
            </MenuItem>
          </MenuList>
        </Menu>
      </HStack>
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
        {state.accounts.map((account) => (
          <AccountTile
            key={account.id}
            account={account}
            isActive={activeAccount?.id === account.id}
            onActivate={() => setActiveAccount(account.id)}
            onRename={(label) => renameAccount(account.id, label)}
            onRemove={() => deleteAccount(account.id)}
            onExport={() => handleExport(account.id)}
          />
        ))}
      </SimpleGrid>
      <HStack spacing={3} align="end">
        <FormControl>
          <FormLabel color="whiteAlpha.700">Label (optional)</FormLabel>
          <Input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="QA wallet, relayer bot…" />
        </FormControl>
        <Button leftIcon={<Plus size={16} />} onClick={handleCreate}>
          Create account
        </Button>
      </HStack>
      <Stack spacing={3}>
        <FormControl>
          <FormLabel color="whiteAlpha.700">Import secret</FormLabel>
          <Input
            value={importPayload}
            onChange={(event) => setImportPayload(event.target.value)}
            placeholder="Paste base58 secret or exported JSON"
          />
          <FormHelperText color="whiteAlpha.500">
            Secrets stay in this browser&apos;s local storage. Export JSON to move accounts between machines.
          </FormHelperText>
        </FormControl>
        <Button onClick={handleImport} variant="outline">
          Import account
        </Button>
      </Stack>
    </Stack>
  );
}

function BalancesPanel() {
  const { activeAccount, tokens, ready } = useSimulation();

  if (!ready) {
    return (
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} height="120px" rounded="2xl" />
        ))}
      </SimpleGrid>
    );
  }

  if (!activeAccount) {
    return (
      <Alert status="info" variant="subtle">
        <AlertIcon />
        <AlertDescription>Activate a simulation account to inspect balances.</AlertDescription>
      </Alert>
    );
  }

  return (
    <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
      {tokens.map((token) => (
        <Stat
          key={token.id}
          bg="rgba(4, 8, 20, 0.95)"
          border="1px solid rgba(59,205,255,0.18)"
          rounded="2xl"
          p={4}
          boxShadow="0 0 22px rgba(59,205,255,0.18)"
        >
          <StatLabel color="whiteAlpha.700">{token.displayName}</StatLabel>
          <StatNumber>{formatAmount(activeAccount.balances[token.id] ?? '0')}</StatNumber>
          <StatHelpText color="whiteAlpha.500">
            {token.category === 'sol' ? 'Test SOL (simulation)' : token.category === 'origin' ? 'Origin mint' : 'Shielded zToken'}
          </StatHelpText>
        </Stat>
      ))}
    </SimpleGrid>
  );
}

function SendForm() {
  const toast = useToast();
  const { activeAccount, tokens, incrementBalance, recordTransaction, state } = useSimulation();
  const [tokenId, setTokenId] = useState<string>(SOL_TOKEN_ID);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('0');
  const [memo, setMemo] = useState('');
  const [isSubmitting, setSubmitting] = useState(false);

  const available = useMemo(() => getBalance(activeAccount, tokenId), [activeAccount, tokenId]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeAccount) {
      toast({ title: 'Activate an account', status: 'warning' });
      return;
    }
    const parsedAmount = Number.parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast({ title: 'Enter a valid amount', status: 'error' });
      return;
    }
    if (!destination || destination.length < 4) {
      toast({ title: 'Destination required', status: 'error' });
      return;
    }
    if (parsedAmount > available) {
      toast({ title: 'Insufficient balance', description: 'Mint more funds from the faucet.', status: 'error' });
      return;
    }

    setSubmitting(true);
    setTimeout(() => {
      incrementBalance(activeAccount.id, tokenId, (-parsedAmount).toString());
      const recipient = state.accounts.find((account) => account.publicKey === destination);
      if (recipient) {
        incrementBalance(recipient.id, tokenId, parsedAmount.toString());
      }
      const transaction: SimTransaction = {
        id: crypto.randomUUID(),
        from: activeAccount.publicKey,
        to: destination,
        tokenId,
        amount: parsedAmount.toString(),
        timestamp: Date.now(),
        type: 'transfer',
        memo: memo || undefined
      };
      recordTransaction(transaction);
      toast({
        title: 'Transfer simulated',
        description: `Sent ${parsedAmount} ${tokens.find((token) => token.id === tokenId)?.symbol ?? ''} to ${destination.slice(0, 4)}…${destination.slice(-4)}.`,
        status: 'success',
        duration: 4000,
        isClosable: true
      });
      setAmount('0');
      setDestination('');
      setMemo('');
      setSubmitting(false);
    }, 400);
  };

  return (
    <chakra.form onSubmit={handleSubmit}>
      <Stack
        spacing={4}
        bg="rgba(10, 14, 30, 0.85)"
        border="1px solid rgba(59,205,255,0.25)"
        rounded="3xl"
        p={{ base: 6, md: 8 }}
        boxShadow="0 0 35px rgba(59,205,255,0.2)"
      >
      <Heading size="md">Send tokens (simulation)</Heading>
      <FormControl>
        <FormLabel color="whiteAlpha.700">Token</FormLabel>
        <Select value={tokenId} onChange={(event) => setTokenId(event.target.value)}>
          {tokens.map((token) => (
            <option key={token.id} value={token.id}>
              {token.symbol}
            </option>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel color="whiteAlpha.700">Destination address</FormLabel>
        <Input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Base58 address" />
        <FormHelperText color="whiteAlpha.500">Paste any simulation address. Existing local accounts receive funds automatically.</FormHelperText>
      </FormControl>
      <FormControl>
        <FormLabel color="whiteAlpha.700">Amount</FormLabel>
        <NumberInput min={0} precision={6} value={amount} onChange={(valueAsString) => setAmount(valueAsString)}>
          <NumberInputField />
        </NumberInput>
        <FormHelperText color="whiteAlpha.500">Available: {available}</FormHelperText>
      </FormControl>
      <FormControl>
        <FormLabel color="whiteAlpha.700">Memo (optional)</FormLabel>
        <Input value={memo} onChange={(event) => setMemo(event.target.value)} />
      </FormControl>
        <Button type="submit" isLoading={isSubmitting} leftIcon={<Send size={16} />}>
          Simulate transfer
        </Button>
      </Stack>
    </chakra.form>
  );
}

function TransactionsTable() {
  const { state, activeAccount, tokens } = useSimulation();

  if (!activeAccount) {
    return (
      <Box
        bg="rgba(4, 8, 20, 0.95)"
        border="1px solid rgba(59,205,255,0.18)"
        rounded="2xl"
        p={4}
      >
        <Text color="whiteAlpha.600">Select an account to view simulated history.</Text>
      </Box>
    );
  }

  const entries = state.transactions.filter(
    (transaction) => transaction.from === activeAccount.publicKey || transaction.to === activeAccount.publicKey
  );

  if (entries.length === 0) {
    return (
      <Box
        bg="rgba(4, 8, 20, 0.95)"
        border="1px solid rgba(59,205,255,0.18)"
        rounded="2xl"
        p={4}
      >
        <Text color="whiteAlpha.600">No simulated transactions yet.</Text>
      </Box>
    );
  }

  return (
    <Box
      bg="rgba(10, 14, 30, 0.85)"
      border="1px solid rgba(59,205,255,0.18)"
      rounded="2xl"
      overflow="hidden"
    >
      <Table variant="simple" size="sm">
        <Tbody>
          {entries.map((transaction) => {
            const token = tokens.find((entry) => entry.id === transaction.tokenId);
            const isOutgoing = transaction.from === activeAccount.publicKey;
            return (
              <Tr key={transaction.id} _hover={{ bg: 'rgba(59,205,255,0.08)' }}>
                <Td>
                  <Text fontWeight="semibold">{isOutgoing ? 'Sent' : 'Received'}</Text>
                  <Text fontSize="xs" color="whiteAlpha.500">
                    {formatTimestamp(transaction.timestamp)}
                  </Text>
                </Td>
                <Td>
                  <Text color={isOutgoing ? 'red.300' : 'green.300'}>
                    {isOutgoing ? '-' : '+'}
                    {formatAmount(transaction.amount)} {token?.symbol ?? ''}
                  </Text>
                </Td>
                <Td>
                  <Text fontSize="xs" color="whiteAlpha.600">
                    {isOutgoing ? '→' : '←'} {isOutgoing ? transaction.to : transaction.from?.slice(0, 8)}…
                  </Text>
                </Td>
                <Td>
                  <Text fontSize="xs" color="whiteAlpha.500">{transaction.memo ?? '—'}</Text>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </Box>
  );
}

export function WalletDashboard() {
  const { ready } = useSimulation();

  return (
    <Stack spacing={10}>
      <Stack spacing={2}>
        <Heading size="2xl">Simulation wallet</Heading>
        <Text color="whiteAlpha.700">
          Burner accounts live entirely in local storage so you can emulate zToken flows without installing Phantom or Solflare.
        </Text>
      </Stack>

      {!ready ? (
        <Stack spacing={6}>
          <Skeleton height="120px" rounded="3xl" />
          <Skeleton height="220px" rounded="3xl" />
        </Stack>
      ) : (
        <>
          <AccountManager />
          <Divider borderColor="rgba(59,205,255,0.25)" />
          <BalancesPanel />
          <Grid templateColumns={{ base: '1fr', lg: '1fr 0.9fr' }} gap={6}>
            <GridItem>
              <SendForm />
            </GridItem>
            <GridItem>
              <TransactionsTable />
            </GridItem>
          </Grid>
        </>
      )}
    </Stack>
  );
}

