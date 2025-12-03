import { Pool } from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// Program IDs (hardcoded for now - should match web/app/lib/onchain/programIds.ts)
const FACTORY_PROGRAM_ID = new PublicKey('94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK');
const POOL_PROGRAM_ID = new PublicKey('ESbKkBQ9P7pavvFPejBXhguBY3BSLtf1LyEQqBNRDHqb');

// PDA derivation functions
const textEncoder = new TextEncoder();

function derivePoolState(originMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('pool'), originMint.toBuffer()],
    POOL_PROGRAM_ID
  )[0];
}

function deriveTokenMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('metadata'), mint.toBuffer()],
    FACTORY_PROGRAM_ID
  )[0];
}

// Load factory IDL
let factoryIdl: Idl | null = null;
async function loadFactoryIdl(): Promise<Idl> {
  if (!factoryIdl) {
    // From indexer/photon/dist/db/ -> go up 4 levels to project root, then to web/app/idl/
    const idlPath = path.join(__dirname, '../../../../web/app/idl/ptf_factory.json');
    try {
      const idlContent = await fs.readFile(idlPath, 'utf8');
      factoryIdl = JSON.parse(idlContent) as Idl;
    } catch (error) {
      logger.error({ err: error, path: idlPath, cwd: process.cwd() }, 'Failed to load factory IDL');
      throw new Error('Failed to load factory IDL');
    }
  }
  return factoryIdl;
}

export interface MintCatalogEntry {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
  zTokenMint: string | null;
  hasPtkn: boolean;
  status: number;
  features: number;
  feeBpsOverride: number | null;
  hasFeeOverride: boolean;
  isNativeZtoken: boolean;
  lookupTable: string | null;
  metadataUri: string | null;
  metadataName: string | null;
  metadataSymbol: string | null;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class MintCatalogStore {
  private pool: Pool | null = null;
  private connection: Connection;
  private factoryCoder!: BorshCoder;
  private syncInterval: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(connection: Connection, databaseUrl?: string) {
    this.connection = connection;
    
    if (databaseUrl) {
      this.pool = new Pool({ connectionString: databaseUrl });
      this.pool.on('error', (err: Error) => {
        logger.error({ err }, 'Postgres pool error');
      });
    }
  }

  async initialize(): Promise<void> {
    // Load factory IDL
    const idl = await loadFactoryIdl();
    this.factoryCoder = new BorshCoder(idl);

    if (!this.pool) {
      logger.warn('No DATABASE_URL provided, mint catalog will not be persisted');
      return;
    }

    try {
      // Run schema migration
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schema = await fs.readFile(schemaPath, 'utf8');
      await this.pool.query(schema);
      logger.info('Mint catalog schema initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize mint catalog schema');
      throw error;
    }

    // Initial sync
    await this.syncFromChain();

    // Start periodic sync (every 5 minutes)
    this.syncInterval = setInterval(() => {
      void this.syncFromChain();
    }, 5 * 60 * 1000);
  }

  async close(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.pool) {
      await this.pool.end();
    }
  }

  async syncFromChain(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('Mint catalog sync already in progress, skipping');
      return;
    }

    if (!this.pool) {
      return;
    }

    this.isSyncing = true;
    try {
      logger.info('Starting mint catalog sync from chain...');
      const accounts = await this.connection.getProgramAccounts(FACTORY_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [{ dataSize: 114 }] // MintMapping::SPACE
      });

      logger.info({ count: accounts.length }, 'Found MintMapping accounts on-chain');

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        for (const account of accounts) {
          try {
            const decoded = this.factoryCoder.accounts.decode('MintMapping', account.account.data) as any;
            
            // Skip if origin_mint is default (uninitialized)
            if (!decoded?.originMint || decoded.originMint === PublicKey.default.toBase58()) {
              continue;
            }

            const originMintKey = new PublicKey(decoded.originMint as PublicKey);
            const originMint = originMintKey.toBase58();
            const poolId = derivePoolState(originMintKey).toBase58();
            const metadataKey = deriveTokenMetadata(originMintKey);

            // Get symbol from decoded or metadata
            let symbol = decoded?.symbol ?? originMint.slice(0, 6).toUpperCase();
            let metadataUri: string | null = null;
            let metadataName: string | null = null;
            let metadataSymbol: string | null = null;

            try {
              const metadataInfo = await this.connection.getAccountInfo(metadataKey, 'confirmed');
              if (metadataInfo) {
                const metadata = this.factoryCoder.accounts.decode('TokenMetadata', metadataInfo.data) as {
                  name: string;
                  symbol: string;
                  uri: string;
                };
                symbol = metadata.symbol || symbol;
                metadataUri = metadata.uri || null;
                metadataName = metadata.name || null;
                metadataSymbol = metadata.symbol || null;
              }
            } catch (error) {
              logger.debug({ err: error, originMint }, 'Failed to fetch token metadata');
            }

            // Extract zToken mint if available
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

            // Extract lookup table
            const lookupTableValue = decoded.lookupTable ?? decoded.lookup_table ?? null;
            const lookupTable = lookupTableValue ? new PublicKey(lookupTableValue).toBase58() : null;

            // Upsert into database
            await client.query(
              `INSERT INTO mint_catalog (
                origin_mint, pool_id, symbol, decimals, z_token_mint, has_ptkn,
                status, features, fee_bps_override, has_fee_override,
                is_native_ztoken, lookup_table, metadata_uri, metadata_name, metadata_symbol,
                last_synced_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
              ON CONFLICT (origin_mint) DO UPDATE SET
                pool_id = EXCLUDED.pool_id,
                symbol = EXCLUDED.symbol,
                decimals = EXCLUDED.decimals,
                z_token_mint = EXCLUDED.z_token_mint,
                has_ptkn = EXCLUDED.has_ptkn,
                status = EXCLUDED.status,
                features = EXCLUDED.features,
                fee_bps_override = EXCLUDED.fee_bps_override,
                has_fee_override = EXCLUDED.has_fee_override,
                is_native_ztoken = EXCLUDED.is_native_ztoken,
                lookup_table = EXCLUDED.lookup_table,
                metadata_uri = EXCLUDED.metadata_uri,
                metadata_name = EXCLUDED.metadata_name,
                metadata_symbol = EXCLUDED.metadata_symbol,
                last_synced_at = NOW()`,
              [
                originMint,
                poolId,
                symbol,
                Number(decoded.decimals ?? 0),
                zTokenMint,
                hasPtkn,
                decoded.status ?? 0,
                decoded.features ?? 0,
                decoded.feeBpsOverride ?? decoded.fee_bps_override ?? null,
                decoded.hasFeeOverride ?? decoded.has_fee_override ?? false,
                decoded.isNativeZtoken ?? decoded.is_native_ztoken ?? false,
                lookupTable,
                metadataUri,
                metadataName,
                metadataSymbol
              ]
            );
          } catch (error) {
            logger.warn({ err: error }, 'Failed to process MintMapping account');
            // Continue with next account
          }
        }

        await client.query('COMMIT');
        logger.info('Mint catalog sync completed successfully');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to sync mint catalog from chain');
    } finally {
      this.isSyncing = false;
    }
  }

  async getAllMints(): Promise<MintCatalogEntry[]> {
    if (!this.pool) {
      return [];
    }

    const result = await this.pool.query<{
      origin_mint: string;
      pool_id: string;
      symbol: string;
      decimals: number;
      z_token_mint: string | null;
      has_ptkn: boolean;
      status: number;
      features: number;
      fee_bps_override: number | null;
      has_fee_override: boolean;
      is_native_ztoken: boolean;
      lookup_table: string | null;
      metadata_uri: string | null;
      metadata_name: string | null;
      metadata_symbol: string | null;
      last_synced_at: Date;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT * FROM mint_catalog ORDER BY symbol, origin_mint`
    );

    return result.rows.map((row) => ({
      originMint: row.origin_mint,
      poolId: row.pool_id,
      symbol: row.symbol,
      decimals: row.decimals,
      zTokenMint: row.z_token_mint,
      hasPtkn: row.has_ptkn,
      status: row.status,
      features: row.features,
      feeBpsOverride: row.fee_bps_override,
      hasFeeOverride: row.has_fee_override,
      isNativeZtoken: row.is_native_ztoken,
      lookupTable: row.lookup_table,
      metadataUri: row.metadata_uri,
      metadataName: row.metadata_name,
      metadataSymbol: row.metadata_symbol,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async getMintByOriginMint(originMint: string): Promise<MintCatalogEntry | null> {
    if (!this.pool) {
      return null;
    }

    const result = await this.pool.query<MintCatalogEntry>(
      `SELECT * FROM mint_catalog WHERE origin_mint = $1`,
      [originMint]
    );

    return result.rows[0] || null;
  }

  async getMintByZTokenMint(zTokenMint: string): Promise<MintCatalogEntry | null> {
    if (!this.pool) {
      return null;
    }

    const result = await this.pool.query<MintCatalogEntry>(
      `SELECT * FROM mint_catalog WHERE z_token_mint = $1`,
      [zTokenMint]
    );

    return result.rows[0] || null;
  }
}
