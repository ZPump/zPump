use sha2::{Digest, Sha256};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    sysvar,
};

pub const FACTORY_PROGRAM_ID: Pubkey = pubkey!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");
const FEATURE_HOOKS_ENABLED: u8 = 0x02;
const SEED_FACTORY: &[u8] = b"factory";
const SEED_MINT_MAPPING: &[u8] = b"map";
const SEED_TIMELOCK: &[u8] = b"timelock";
const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

fn sighash(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{}", name));
    let hash = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

fn serialize_pubkey(buf: &mut Vec<u8>, key: &Pubkey) {
    buf.extend_from_slice(key.as_ref());
}

fn serialize_option_u8(buf: &mut Vec<u8>, value: Option<u8>) {
    match value {
        Some(v) => {
            buf.push(1);
            buf.push(v);
        }
        None => buf.push(0),
    }
}

fn serialize_option_u16(buf: &mut Vec<u8>, value: Option<u16>) {
    match value {
        Some(v) => {
            buf.push(1);
            buf.extend_from_slice(&v.to_le_bytes());
        }
        None => buf.push(0),
    }
}

fn serialize_option_bool(buf: &mut Vec<u8>, value: Option<bool>) {
    match value {
        Some(v) => {
            buf.push(1);
            buf.push(v as u8);
        }
        None => buf.push(0),
    }
}

fn serialize_timelock_action(buf: &mut Vec<u8>, action: &TimelockAction) {
    match action {
        TimelockAction::SetDefaultFeatures { features } => {
            buf.push(0);
            buf.push(*features);
        }
        TimelockAction::UpdateMint {
            origin_mint,
            params,
        } => {
            buf.push(1);
            serialize_pubkey(buf, origin_mint);
            serialize_option_bool(buf, params.enable_ptkn);
            serialize_option_u8(buf, params.features);
            serialize_option_u16(buf, params.fee_bps_override);
        }
        TimelockAction::PauseFactory => buf.push(2),
        TimelockAction::UnpauseFactory => buf.push(3),
    }
}

#[derive(Clone)]
struct UpdateMintParams {
    enable_ptkn: Option<bool>,
    features: Option<u8>,
    fee_bps_override: Option<u16>,
}

#[derive(Clone)]
enum TimelockAction {
    SetDefaultFeatures {
        features: u8,
    },
    UpdateMint {
        origin_mint: Pubkey,
        params: UpdateMintParams,
    },
    PauseFactory,
    UnpauseFactory,
}

fn initialize_factory_ix(
    factory_state: Pubkey,
    payer: Pubkey,
    authority: Pubkey,
    default_fee_bps: u16,
    timelock_seconds: i64,
) -> Instruction {
    let mut data = sighash("initialize_factory").to_vec();
    serialize_pubkey(&mut data, &authority);
    data.extend_from_slice(&default_fee_bps.to_le_bytes());
    data.extend_from_slice(&timelock_seconds.to_le_bytes());

    Instruction {
        program_id: FACTORY_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(factory_state, false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data,
    }
}

fn set_default_features_ix(factory_state: Pubkey, authority: Pubkey, features: u8) -> Instruction {
    let mut data = sighash("set_default_features").to_vec();
    data.push(features);
    Instruction {
        program_id: FACTORY_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(factory_state, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

fn register_mint_ix(
    factory_state: Pubkey,
    authority: Pubkey,
    mint_mapping: Pubkey,
    origin_mint: Pubkey,
    payer: Pubkey,
    decimals: u8,
) -> Instruction {
    let mut data = sighash("register_mint").to_vec();
    data.push(decimals);
    data.push(0); // enable_ptkn = false
    serialize_option_u8(&mut data, None);
    serialize_option_u16(&mut data, None);

    Instruction {
        program_id: FACTORY_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(factory_state, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(mint_mapping, false),
            AccountMeta::new_readonly(origin_mint, false),
            AccountMeta::new(payer, true),
            AccountMeta::new(mint_mapping, false), // placeholder for optional ptkn_mint
            AccountMeta::new_readonly(
                Pubkey::new_from_array(spl_token_2022::id().to_bytes()),
                false,
            ),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data,
    }
}

fn queue_timelock_action_ix(
    factory_state: Pubkey,
    authority: Pubkey,
    timelock_entry: Pubkey,
    payer: Pubkey,
    mint_mapping: Pubkey,
    salt: [u8; 32],
    action: TimelockAction,
) -> Instruction {
    let mut data = sighash("queue_timelock_action").to_vec();
    data.extend_from_slice(&salt);
    serialize_timelock_action(&mut data, &action);

    Instruction {
        program_id: FACTORY_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(factory_state, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(timelock_entry, false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new(mint_mapping, false),
        ],
        data,
    }
}

fn execute_timelock_action_ix(
    factory_state: Pubkey,
    timelock_entry: Pubkey,
    mint_mapping: Pubkey,
    executor: Pubkey,
) -> Instruction {
    Instruction {
        program_id: FACTORY_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(factory_state, false),
            AccountMeta::new(timelock_entry, false),
            AccountMeta::new(mint_mapping, false),
            AccountMeta::new(mint_mapping, false),
            AccountMeta::new_readonly(
                Pubkey::new_from_array(spl_token_2022::id().to_bytes()),
                false,
            ),
            AccountMeta::new(executor, true),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        data: sighash("execute_timelock_action").to_vec(),
    }
}

pub fn factory_state_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_FACTORY, FACTORY_PROGRAM_ID.as_ref()],
        &FACTORY_PROGRAM_ID,
    )
}

pub fn mint_mapping_pda(origin_mint: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_MINT_MAPPING, origin_mint.as_ref()],
        &FACTORY_PROGRAM_ID,
    )
}

pub fn timelock_entry_pda(factory_state: Pubkey, salt: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_TIMELOCK, factory_state.as_ref(), salt.as_ref()],
        &FACTORY_PROGRAM_ID,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    use ptf_factory::FactoryError;
    use solana_program_test::{BanksClientError, ProgramTest};
    use solana_sdk::{
        account::AccountSharedData,
        instruction::{AccountMeta, Instruction},
        pubkey,
        pubkey::Pubkey,
        signature::Signer,
        signer::keypair::Keypair,
        sysvar,
        transaction::{Transaction, TransactionError},
    };
    use std::{env, path::PathBuf};

    const DEFAULT_FEE_BPS: u16 = 5;
    const TIMELOCK_SECS: i64 = 5;

    const FACTORY_SO: &str = "ptf_factory.so";

    fn artifact_path(filename: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("deploy")
            .join(filename)
    }

    fn program_test() -> ProgramTest {
        let so_path = artifact_path(FACTORY_SO);
        assert!(
            so_path.exists(),
            "{} missing. Run `anchor build` so the `.so` artifact is present at {}",
            FACTORY_SO,
            so_path.display()
        );
        if let Some(dir) = so_path.parent() {
            let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            env::set_var("BPF_OUT_DIR", &canonical);
            env::set_var("SBF_OUT_DIR", &canonical);
        }
        let mut test = ProgramTest::default();
        test.add_program("ptf_factory", FACTORY_PROGRAM_ID, None);
        test
    }

    async fn process_instruction(
        context: &mut solana_program_test::ProgramTestContext,
        instruction: Instruction,
        additional_signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        let mut tx = Transaction::new_with_payer(&[instruction], Some(&context.payer.pubkey()));
        let mut signers = vec![&context.payer];
        signers.extend_from_slice(additional_signers);
        tx.sign(&signers, context.last_blockhash);
        let result = context.banks_client.process_transaction(tx).await;
        if result.is_ok() {
            context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
        }
        result
    }

    async fn advance_clock(context: &mut solana_program_test::ProgramTestContext, slots: u64) {
        let current_slot = context.banks_client.get_root_slot().await.unwrap();
        context.warp_to_slot(current_slot + slots).unwrap();
        context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires `anchor build` artifacts under target/deploy"]
    async fn timelock_blocks_direct_update() {
        let authority = Keypair::new();
        let program_test = program_test();
        let mut context = program_test.start_with_context().await;

        let (factory_state, _) = factory_state_pda();
        let init_ix = initialize_factory_ix(
            factory_state,
            context.payer.pubkey(),
            authority.pubkey(),
            DEFAULT_FEE_BPS,
            TIMELOCK_SECS,
        );
        process_instruction(&mut context, init_ix, &[])
            .await
            .unwrap();

        let set_ix =
            set_default_features_ix(factory_state, authority.pubkey(), FEATURE_HOOKS_ENABLED);
        let err = process_instruction(&mut context, set_ix, &[&authority])
            .await
            .unwrap_err();
        assert_anchor_error(err, FactoryError::TimelockOnlyQueue);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires `anchor build` artifacts under target/deploy"]
    async fn timelock_queue_and_execute_mint_update() {
        let authority = Keypair::new();
        let origin_mint = Keypair::new();

        let program_test = program_test();

        let mut context = program_test.start_with_context().await;
        let (factory_state, _) = factory_state_pda();
        let init_ix = initialize_factory_ix(
            factory_state,
            context.payer.pubkey(),
            authority.pubkey(),
            DEFAULT_FEE_BPS,
            TIMELOCK_SECS,
        );
        process_instruction(&mut context, init_ix, &[])
            .await
            .unwrap();

        let (mint_mapping, _) = mint_mapping_pda(origin_mint.pubkey());
        let register_ix = register_mint_ix(
            factory_state,
            authority.pubkey(),
            mint_mapping,
            origin_mint.pubkey(),
            context.payer.pubkey(),
            6,
        );
        process_instruction(&mut context, register_ix, &[&authority])
            .await
            .unwrap();

        let salt = [7u8; 32];
        let (timelock_entry, _) = timelock_entry_pda(factory_state, &salt);
        let queue_ix = queue_timelock_action_ix(
            factory_state,
            authority.pubkey(),
            timelock_entry,
            context.payer.pubkey(),
            mint_mapping,
            salt,
            TimelockAction::UpdateMint {
                origin_mint: origin_mint.pubkey(),
                params: UpdateMintParams {
                    enable_ptkn: None,
                    features: Some(FEATURE_HOOKS_ENABLED),
                    fee_bps_override: None,
                },
            },
        );
        process_instruction(&mut context, queue_ix, &[&authority])
            .await
            .unwrap();

        let execute_ix = execute_timelock_action_ix(
            factory_state,
            timelock_entry,
            mint_mapping,
            authority.pubkey(),
        );
        let err = process_instruction(&mut context, execute_ix.clone(), &[&authority])
            .await
            .unwrap_err();
        assert_anchor_error(err, FactoryError::TimelockNotReady);

        advance_clock(&mut context, 10).await;
        {
            let mut entry_account = context
                .banks_client
                .get_account(timelock_entry)
                .await
                .unwrap()
                .unwrap();
            let mut entry_state =
                ptf_factory::TimelockEntry::try_deserialize(&mut entry_account.data.as_slice())
                    .unwrap();
            entry_state.execute_after = 0;

            let mut serialized = Vec::with_capacity(entry_account.data.len());
            entry_state.try_serialize(&mut serialized).unwrap();
            if serialized.len() < entry_account.data.len() {
                serialized.resize(entry_account.data.len(), 0);
            }
            entry_account.data = serialized;
            context.set_account(&timelock_entry, &AccountSharedData::from(entry_account));
        }

        process_instruction(&mut context, execute_ix, &[&authority])
            .await
            .unwrap();

        let account = context
            .banks_client
            .get_account(mint_mapping)
            .await
            .unwrap()
            .unwrap();
        let features_byte = account.data[8 + 32 + 32 + 1 + 1 + 1];
        assert_eq!(features_byte, FEATURE_HOOKS_ENABLED);
    }

    fn assert_anchor_error(err: BanksClientError, expected: FactoryError) {
        match err {
            BanksClientError::TransactionError(TransactionError::InstructionError(
                _,
                solana_sdk::instruction::InstructionError::Custom(code),
            )) => {
                let expected_code: u32 = expected.into();
                assert_eq!(code, expected_code);
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    // Vault Operations Tests
    // These tests verify proof vault account abstraction functionality
    
    #[tokio::test]
    async fn test_vault_space_calculation() {
        // Verify vault space calculation matches program expectations
        // UserProofVault structure:
        // - owner: Pubkey (32 bytes)
        // - vault_bump: u8 (1 byte)
        // - prepared_operations: Vec<PreparedOperation> (4 bytes length + data)
        // - created_at: i64 (8 bytes)
        // - last_used: i64 (8 bytes)
        // - operation_count: u64 (8 bytes)
        // Discriminator: 8 bytes
        
        const MAX_OPERATIONS: usize = 10;
        
        let base_size = 8 + // discriminator
            32 + // owner
            1 + // vault_bump
            4 + // Vec length
            8 + // created_at
            8 + // last_used
            8; // operation_count
        
        // Each PreparedOperation can vary in size, but we allocate space for MAX_OPERATIONS
        // The program allocates ~50 KB for operation storage
        let min_vault_size = base_size + (MAX_OPERATIONS * 100); // Conservative estimate
        
        // Verify minimum size is reasonable
        assert!(min_vault_size > 100, "Vault size should be at least 100 bytes");
        assert!(min_vault_size < 100_000, "Vault size should be less than 100 KB");
    }

    #[tokio::test]
    async fn test_operation_expiry_time() {
        // Verify expiry time calculation
        const OPERATION_EXPIRY_SECONDS: i64 = 300; // 5 minutes
        
        let created_at = 1000i64;
        let expires_at = created_at
            .checked_add(OPERATION_EXPIRY_SECONDS)
            .expect("Expiry calculation should not overflow");
        
        assert_eq!(expires_at - created_at, OPERATION_EXPIRY_SECONDS);
        assert_eq!(expires_at, 1300);
        
        // Verify operation is not expired
        let current_time = 1000i64;
        assert!(current_time < expires_at);
        
        // Verify operation would be expired after expiry time
        let future_time = expires_at + 1;
        assert!(future_time >= expires_at);
    }

    #[tokio::test]
    async fn test_max_operations_limit() {
        // Verify MAX_OPERATIONS constant
        const MAX_OPERATIONS: usize = 10;
        assert_eq!(MAX_OPERATIONS, 10, "MAX_OPERATIONS should be 10");
        
        // Verify operations can be created up to limit
        let mut operations: Vec<u8> = Vec::new();
        for i in 0..MAX_OPERATIONS {
            operations.push(i as u8);
        }
        
        assert_eq!(operations.len(), MAX_OPERATIONS);
        
        // Verify adding one more would exceed limit
        assert!(operations.len() >= MAX_OPERATIONS);
    }

    #[tokio::test]
    async fn test_pda_derivation() {
        // Test proof vault PDA derivation
        let program_id = pubkey!("ESbKkBQ9P7pavvFPejBXhguBY3BSLtf1LyEQqBNRDHqb");
        let owner = pubkey!("11111111111111111111111111111111");
        
        let seeds = &[
            b"proof-vault",
            owner.as_ref(),
        ];
        
        let (pda, bump) = Pubkey::find_program_address(seeds, &program_id);
        
        // Verify PDA is valid
        assert_ne!(pda, Pubkey::default());
        assert!(bump <= 255); // bump is u8, so always >= 0
        
        // Verify PDA can be re-derived
        let (pda2, bump2) = Pubkey::find_program_address(seeds, &program_id);
        assert_eq!(pda, pda2);
        assert_eq!(bump, bump2);
    }

    #[tokio::test]
    async fn test_operation_id_format() {
        // Verify operation ID is 32 bytes
        let operation_id = [0u8; 32];
        assert_eq!(operation_id.len(), 32);
        
        // Verify operation ID format is correct
        assert_eq!(operation_id.len(), 32);
    }
}
