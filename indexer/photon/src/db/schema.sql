-- Mint Catalog Table
-- Stores mint information synced from on-chain MintMapping accounts
CREATE TABLE IF NOT EXISTS mint_catalog (
    origin_mint TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    z_token_mint TEXT,
    has_ptkn BOOLEAN NOT NULL DEFAULT false,
    status INTEGER NOT NULL DEFAULT 0,
    features INTEGER NOT NULL DEFAULT 0,
    fee_bps_override INTEGER,
    has_fee_override BOOLEAN NOT NULL DEFAULT false,
    is_native_ztoken BOOLEAN NOT NULL DEFAULT false,
    lookup_table TEXT,
    metadata_uri TEXT,
    metadata_name TEXT,
    metadata_symbol TEXT,
    last_synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_mint_catalog_z_token_mint ON mint_catalog(z_token_mint) WHERE z_token_mint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mint_catalog_symbol ON mint_catalog(symbol);
CREATE INDEX IF NOT EXISTS idx_mint_catalog_last_synced ON mint_catalog(last_synced_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_mint_catalog_updated_at ON mint_catalog;
CREATE TRIGGER update_mint_catalog_updated_at
    BEFORE UPDATE ON mint_catalog
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

