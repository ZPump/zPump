'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Skeleton,
  Stack,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Text,
  Tooltip,
  useClipboard,
  useToast
} from '@chakra-ui/react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMint
} from '@solana/spl-token';
import type { MintConfig } from '../../config/mints';
import { deriveVaultState } from '../../lib/onchain/pdas';
import { Copy, RefreshCw } from 'lucide-react';
import { useMintCatalog } from '../providers/MintCatalogProvider';

interface MintSnapshot {
  config: MintConfig;
  vaultState: string;
  vaultTokenAccount: string;
  decimals: number;
  supply: string;
  vaultBalance: string;
}

function formatLamports(amount: string, decimals: number): string {
  try {
    const value = BigInt(amount);
    if (decimals === 0) {
      return value.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = value % divisor;
    if (fraction === 0n) {
      return whole.toString();
    }
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '');
    return `${whole.toString()}.${fractionStr}`;
  } catch {
    return amount;
  }
}

export function VaultDashboard() {
  const { connection } = useConnection();
  const toast = useToast();
  const { mints, loading: mintCatalogLoading, error: mintCatalogError } = useMintCatalog();
  const [snapshots, setSnapshots] = useState<MintSnapshot[]>([]);
  const [isLoading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    if (!mints.length) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(
        mints.map(async (mint) => {
          const originMintKey = new PublicKey(mint.originMint);
          const vaultStateKey = deriveVaultState(originMintKey);
          const vaultTokenAccount = await getAssociatedTokenAddress(
            originMintKey,
            vaultStateKey,
            true,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );

          const [mintInfo, vaultBalanceInfo] = await Promise.all([
            getMint(connection, originMintKey),
            connection.getTokenAccountBalance(vaultTokenAccount).catch(() => null)
          ]);

          const decimals = mintInfo.decimals;
          const supply = mintInfo.supply.toString();
          const vaultBalance = vaultBalanceInfo?.value?.amount ?? '0';

          return {
            config: mint,
            vaultState: vaultStateKey.toBase58(),
            vaultTokenAccount: vaultTokenAccount.toBase58(),
            decimals,
            supply,
            vaultBalance
          } satisfies MintSnapshot;
        })
      );
      setSnapshots(entries);
    } catch (caught) {
      setError((caught as Error).message ?? 'Failed to load vault metrics');
      toast({
        title: 'Unable to load vault metrics',
        description: (caught as Error).message,
        status: 'error',
        duration: 4000,
        isClosable: true
      });
    } finally {
      setLoading(false);
    }
  }, [connection, toast, mints]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  if (mintCatalogError) {
    return (
      <Alert status="error" variant="left-accent">
        <AlertIcon />
        <AlertDescription>
          Unable to load the mint catalogue. {mintCatalogError}. Run the bootstrap or refresh the page.
        </AlertDescription>
      </Alert>
    );
  }

  if (!mintCatalogLoading && !mints.length) {
    return (
      <Alert status="info" variant="left-accent">
        <AlertIcon />
        <AlertDescription>
          No origin mints registered yet. Run the private devnet bootstrap to generate real mint metadata.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Stack spacing={8}>
      <HStack justify="space-between" align="center">
        <Heading size="2xl">Vault observability</Heading>
        <Button
          leftIcon={<RefreshCw size={16} />}
          variant="outline"
          onClick={() => void loadSnapshots()}
          isLoading={isLoading}
        >
          Refresh metrics
        </Button>
      </HStack>
      <Text color="whiteAlpha.700">
        Inspect the program-owned vaults that custody origin tokens for each registered mint. Values update directly from the
        Solana RPC so you can verify supply invariants after bootstrapping the devnet.
      </Text>
      {error && (
        <Alert status="error" variant="left-accent">
          <AlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Stack spacing={6}>
        {snapshots.map((snapshot) => (
          <Box
            key={snapshot.config.originMint}
            bg="rgba(20, 18, 14, 0.88)"
            border="1px solid rgba(245,178,27,0.2)"
            rounded="2xl"
            p={{ base: 6, md: 8 }}
            boxShadow="0 0 35px rgba(245, 178, 27, 0.2)"
          >
            <Stack spacing={4}>
              <HStack justify="space-between" align={{ base: 'flex-start', md: 'center' }} flexDir={{ base: 'column', md: 'row' }}>
                <Heading size="md">{snapshot.config.symbol}</Heading>
                <Text color="whiteAlpha.600">Pool PDA: {snapshot.config.poolId}</Text>
              </HStack>
              <Stack spacing={2} fontFamily="mono" fontSize="sm">
                <CopyField label="Origin mint" value={snapshot.config.originMint} />
                <CopyField label="Vault state" value={snapshot.vaultState} />
                <CopyField label="Vault token account" value={snapshot.vaultTokenAccount} />
              </Stack>
              <Stack direction={{ base: 'column', md: 'row' }} spacing={4} align="stretch">
                <Stat bg="rgba(24, 20, 16, 0.9)" p={4} rounded="xl" flex="1">
                  <StatLabel>Decimals</StatLabel>
                  <StatNumber>{snapshot.decimals}</StatNumber>
                  <StatHelpText color="whiteAlpha.600">On-chain mint metadata</StatHelpText>
                </Stat>
                <Stat bg="rgba(24, 20, 16, 0.9)" p={4} rounded="xl" flex="1">
                  <StatLabel>Total supply</StatLabel>
                  <StatNumber>{formatLamports(snapshot.supply, snapshot.decimals)}</StatNumber>
                  <StatHelpText color="whiteAlpha.600">Mint supply (base units)</StatHelpText>
                </Stat>
                <Stat bg="rgba(24, 20, 16, 0.9)" p={4} rounded="xl" flex="1">
                  <StatLabel>Vault balance</StatLabel>
                  <StatNumber>{formatLamports(snapshot.vaultBalance, snapshot.decimals)}</StatNumber>
                  <StatHelpText color="whiteAlpha.600">Origin tokens held in custody</StatHelpText>
                </Stat>
              </Stack>
              <Text fontSize="sm" color="whiteAlpha.500">
                Vault balances should equal circulating privacy supply minus protocol fees. Use this dashboard after running the
                devnet bootstrap to confirm invariants.
              </Text>
            </Stack>
          </Box>
        ))}
        {isLoading && snapshots.length === 0 && mints.length > 0 && (
          <Stack spacing={3}>
            {mints.map((mint) => (
              <Skeleton key={mint.originMint} height="180px" rounded="2xl" />
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { onCopy, hasCopied } = useClipboard(value);
  return (
    <HStack spacing={3} align="center">
      <Text color="whiteAlpha.500" minW="130px">
        {label}:
      </Text>
      <Text color="whiteAlpha.800" flex="1" overflow="hidden" textOverflow="ellipsis">
        {value}
      </Text>
      <Tooltip label={hasCopied ? 'Copied' : 'Copy address'}>
        <IconButton
          aria-label={`Copy ${label}`}
          icon={<Copy size={15} />}
          size="sm"
          variant="ghost"
          onClick={onCopy}
        />
      </Tooltip>
    </HStack>
  );
}
