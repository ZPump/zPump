import type { NextApiRequest, NextApiResponse } from 'next';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import factoryIdl from '../../idl/ptf_factory.json';
import type { MintConfig } from '../../config/mints';
import { bootstrapPrivateDevnet } from '../../scripts/bootstrap-private-devnet';
import { getRepoRoot } from '../../lib/server/paths';
import {
  GeneratedMint,
  mapGeneratedMint,
  readMintCatalog,
  writeMintCatalog
} from '../../lib/server/mintCatalog';
import { derivePoolState, deriveTokenMetadata } from '../../lib/onchain/pdas';
import { FACTORY_PROGRAM_ID } from '../../lib/onchain/programIds';

const PROJECT_ROOT = getRepoRoot();
const PLACEHOLDER_ORIGIN = 'Mint111111111111111111111111111111111111111';
const PLACEHOLDER_POOL = 'Pool111111111111111111111111111111111111111';
const MINT_MAPPING_DATA_SIZE = 114; // Updated to 114 bytes: 81 base + 33 bytes for Option<Pubkey> lookup_table
const IS_NATIVE_OFFSET = 80; // is_native_ztoken is still at byte 72 (body offset 0), but account size is now 114
const TRUE_BYTE = bs58.encode(Buffer.from([1]));
const coder = new BorshCoder(factoryIdl as Idl);

let bootstrapInFlight = false;

function isLocalFaucetMode(): boolean {
  const mode = process.env.FAUCET_MODE ?? process.env.NEXT_PUBLIC_FAUCET_MODE ?? 'local';
  return mode === 'local';
}

function getRpcUrl(): string {
  return process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899';
}

function decodeMintMappingAccount(data: Buffer): any | null {
  try {
    return coder.accounts.decode('MintMapping', data);
  } catch (error) {
    if (data.length === 81 || data.length === 73 || data.length === 82) {
      try {
        const padded = Buffer.concat([data, Buffer.alloc(Math.max(0, MINT_MAPPING_DATA_SIZE - data.length), 0)]);
        return coder.accounts.decode('MintMapping', padded);
      } catch (inner) {
        console.warn('[api/mints] Unable to decode legacy MintMapping', { error: inner });
        return null;
      }
    }
    console.warn('[api/mints] Unable to decode MintMapping', { error });
    return null;
  }
}

async function fetchNativeMintEntries(): Promise<GeneratedMint[]> {
  try {
    const connection = new Connection(getRpcUrl(), 'confirmed');
    // Fetch ALL mint mappings (not just isNativeZtoken=true) since we now create regular tokens
    const accounts = await connection.getProgramAccounts(FACTORY_PROGRAM_ID, {
      commitment: 'confirmed'
    });

    const entries: GeneratedMint[] = [];
    for (const account of accounts) {
      const decoded = decodeMintMappingAccount(account.account.data);
      if (!decoded) {
        continue;
      }

      // Skip if origin_mint is default (uninitialized)
      const originMintRaw =
        decoded.originMint ??
        decoded.origin_mint ??
        (decoded.originMint?.toBase58 ? decoded.originMint.toBase58() : null);
      if (!originMintRaw || originMintRaw === PublicKey.default.toBase58()) {
        continue;
      }

      const originMintKey =
        originMintRaw instanceof PublicKey ? originMintRaw : new PublicKey(originMintRaw);
      const originMint = originMintKey.toBase58();
      const poolId = derivePoolState(originMintKey).toBase58();
      const metadataKey = deriveTokenMetadata(originMintKey);

      const rawSymbol = decoded?.symbol ?? decoded?.Symbol ?? decoded?.symbol ?? null;
      let symbol = rawSymbol ?? originMint.slice(0, 6).toUpperCase();
      let metadataUri: string | null = null;
      try {
        const metadataInfo = await connection.getAccountInfo(metadataKey, 'confirmed');
        if (metadataInfo) {
          const metadata = coder.accounts.decode('TokenMetadata', metadataInfo.data) as {
            name: string;
            symbol: string;
            uri: string;
          };
          symbol = metadata.symbol || symbol;
          metadataUri = metadata.uri || null;
        }
      } catch (error) {
        console.warn('[api/mints] Failed to decode token metadata', { originMint, error });
      }

      // Check if this mint has a zToken (ptkn mint)
      let zTokenMint: string | null = null;
      const hasPtkn = decoded.hasPtkn ?? decoded.has_ptkn ?? false;
      if (hasPtkn) {
        const ptknMint = decoded.ptknMint || decoded.ptkn_mint;
        if (ptknMint) {
          try {
            zTokenMint = new PublicKey(ptknMint).toBase58();
          } catch {
            // Invalid public key, leave as null
          }
        }
      }
      
      entries.push({
        symbol,
        originMint,
        poolId,
        decimals: Number(decoded.decimals ?? 0),
        zTokenMint,
        features: {
          zTokenEnabled: true,
          wrappedTransfers: false
        },
        lookupTable: null,
        metadataUri,
        isNativeZToken: false // All tokens are now regular tokens
      });
    }
    return entries;
  } catch (error) {
    console.warn('[api/mints] Failed to fetch native zTokens', error);
    return [];
  }
}

async function handleGet(res: NextApiResponse) {
  const indexerUrl = process.env.INDEXER_INTERNAL_URL ?? process.env.INDEXER_URL ?? 'http://127.0.0.1:8787';
  let indexerMints: MintConfig[] = [];

  try {
    const indexerResponse = await fetch(`${indexerUrl}/mints`, {
      headers: {
        'x-ptf-api-key': process.env.INDEXER_API_KEY ?? process.env.API_KEY ?? ''
      }
    });
    if (indexerResponse.ok) {
      const indexerData = await indexerResponse.json();
      if (Array.isArray(indexerData.mints)) {
        indexerMints = indexerData.mints as MintConfig[];
      }
    }
  } catch (error) {
    console.warn('[api/mints] Indexer not available, falling back to on-chain fetch', error);
  }

  const [catalog, nativeEntries] = await Promise.all([readMintCatalog(), fetchNativeMintEntries()]);
  const filteredCatalog = catalog.filter(
    (entry) => entry.originMint !== PLACEHOLDER_ORIGIN && entry.poolId !== PLACEHOLDER_POOL
  );

  const mergedGenerated = new Map<string, GeneratedMint>();
  for (const entry of filteredCatalog) {
    mergedGenerated.set(entry.originMint, entry);
  }
  for (const entry of nativeEntries) {
    if (!mergedGenerated.has(entry.originMint)) {
      mergedGenerated.set(entry.originMint, entry);
    } else {
      const existing = mergedGenerated.get(entry.originMint)!;
      mergedGenerated.set(entry.originMint, {
        ...existing,
        ...entry,
        metadataUri: entry.metadataUri ?? existing.metadataUri,
        isNativeZToken: entry.isNativeZToken ?? existing.isNativeZToken
      });
    }
  }

  const fallbackMints = Array.from(mergedGenerated.values()).map(mapGeneratedMint);
  const combined = new Map<string, MintConfig>();

  for (const mint of indexerMints) {
    combined.set(mint.originMint, mint);
  }

  for (const mint of fallbackMints) {
    if (combined.has(mint.originMint)) {
      const existing = combined.get(mint.originMint)!;
      combined.set(mint.originMint, {
        ...mint,
        symbol: existing.symbol || mint.symbol,
        metadataUri: existing.metadataUri ?? mint.metadataUri,
        lookupTable: existing.lookupTable ?? mint.lookupTable
      });
    } else {
      combined.set(mint.originMint, mint);
    }
  }

  res.status(200).json({ mints: Array.from(combined.values()) });
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  if (!isLocalFaucetMode()) {
    res.status(403).json({ error: 'mint_registration_disabled' });
    return;
  }
  if (bootstrapInFlight) {
    res.status(429).json({ error: 'mint_registration_in_progress' });
    return;
  }
  let payload: { symbol?: string; decimals?: number };
  try {
    payload = req.body as { symbol?: string; decimals?: number };
  } catch {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }
  const symbol = payload.symbol?.trim().toUpperCase();
  const decimals = Number(payload.decimals);
  if (!symbol || symbol.length < 2 || symbol.length > 6) {
    res.status(400).json({ error: 'invalid_symbol' });
    return;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    res.status(400).json({ error: 'invalid_decimals' });
    return;
  }

  bootstrapInFlight = true;
  try {
    const existing = await readMintCatalog();
    if (existing.some((entry) => entry.symbol.toUpperCase() === symbol)) {
      res.status(409).json({ error: 'symbol_exists' });
      return;
    }
    existing.push({
      symbol,
      decimals,
      originMint: PLACEHOLDER_ORIGIN,
      poolId: PLACEHOLDER_POOL,
      zTokenMint: null,
      features: {
        zTokenEnabled: true,
        wrappedTransfers: false
      },
      lookupTable: null
    });
    await writeMintCatalog(existing);

    await bootstrapPrivateDevnet();

    const refreshed = await readMintCatalog();
    const created = refreshed.find((entry) => entry.symbol.toUpperCase() === symbol);
    if (!created) {
      res.status(500).json({ error: 'mint_creation_failed' });
      return;
    }
    res.status(200).json({ mint: mapGeneratedMint(created) });
  } catch (error) {
    const errorMessage = (error as Error).message ?? 'mint_registration_failed';
    const errorStack = (error as Error).stack ?? '';
    console.error('[api/mints] mint registration failed', {
      message: errorMessage,
      stack: errorStack,
      error: error
    });
    
    // Provide more helpful error messages for common issues
    let statusCode = 500;
    let errorResponse = errorMessage;
    
    if (errorMessage.includes('0x0') || errorMessage.includes('custom program error: 0x0')) {
      // Log the full error for debugging
      console.error('[api/mints] 0x0 error details:', {
        fullError: String(error),
        message: errorMessage,
        stack: errorStack
      });
      errorResponse = `Account already exists in uninitialized state. Full error: ${errorMessage}`;
      statusCode = 409; // Conflict
    } else if (errorMessage.includes('InvalidMintFormat') || errorMessage.includes('Invalid mint format')) {
      errorResponse = 'Mint account is in an invalid state. The mint_mapping account may exist but be owned by the wrong program. Try using a different mint.';
      statusCode = 400;
    } else if (errorMessage.includes('AlreadyRegistered')) {
      errorResponse = 'This mint is already registered.';
      statusCode = 409;
    } else if (errorMessage.includes('Cannot register mint') && errorMessage.includes('uninitialized')) {
      // This is our check failing - the mint_mapping is uninitialized
      errorResponse = errorMessage;
      statusCode = 400;
    }
    
    res.status(statusCode).json({
      error: errorResponse
    });
  } finally {
    bootstrapInFlight = false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      await handleGet(res);
      return;
    }
    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end('Method Not Allowed');
  } catch (error) {
    console.error('[api/mints] unexpected failure', error);
    res.status(500).json({ error: 'internal_error' });
  }
}

