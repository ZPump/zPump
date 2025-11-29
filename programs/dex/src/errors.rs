use anchor_lang::prelude::*;

#[error_code]
pub enum DexError {
    #[msg("Pool already exists")]
    PoolAlreadyExists,
    
    #[msg("Pool does not exist")]
    PoolNotFound,
    
    #[msg("Invalid token pair: same token for A and B")]
    InvalidTokenPair,
    
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
    
    #[msg("Invalid proof for zToken operation")]
    InvalidProof,
    
    #[msg("Mint mismatch")]
    MintMismatch,
    
    #[msg("Insufficient LP tokens")]
    InsufficientLPTokens,
    
    #[msg("Invalid reserve state")]
    InvalidReserveState,
    
    #[msg("Math overflow")]
    MathOverflow,
    
    #[msg("Unauthorized")]
    Unauthorized,
    
    #[msg("Token type mismatch")]
    TokenTypeMismatch,
    
    #[msg("Pool not initialized")]
    PoolNotInitialized,
    
    #[msg("Invalid mint format")]
    InvalidMintFormat,
    
    #[msg("Invalid account")]
    InvalidAccount,
}

