// Minimal reproduction case for Anchor access violation bug
// This demonstrates an access violation in Anchor's validation phase before function execution

use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;

    // This instruction works fine
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, data: [u8; 32]) -> Result<()> {
        msg!("execute_transfer: start");
        Ok(())
    }

    // This instruction causes access violation at 0x200005880 in Anchor validation
    // BEFORE the function entry point is reached
    pub fn shield_execute(ctx: Context<ExecuteShield>, data: [u8; 32]) -> Result<()> {
        msg!("shield_execute: start");
        Ok(())
    }
}

// Working struct - 4 accounts, same pattern
#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub proof_vault: UncheckedAccount<'info>,
    pub system_program: UncheckedAccount<'info>,
    pub rent: UncheckedAccount<'info>,
}

// Failing struct - IDENTICAL pattern, causes access violation
#[derive(Accounts)]
pub struct ExecuteShield<'info> {
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub proof_vault: UncheckedAccount<'info>,
    pub system_program: UncheckedAccount<'info>,
    pub rent: UncheckedAccount<'info>,
}
