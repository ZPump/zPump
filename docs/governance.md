---
title: Governance & Relayer Roadmap
owner: Hendo
status: Draft (sync with Spec v0.5)
---

# Governance Playbooks

## 1. Enabling Privacy Twins (PTkn) for an Origin Mint

**Pre-requisites**
- `mint_mapping.has_ptkn == false` (expected state after bootstrap)
- Governance-controlled wallet holds authority over `FactoryState`
- Twin mint verifying keys already registered via bootstrap (shield/unshield circuits)

**Steps**
1. **Vote + execute `update_mint`** on `ptf_factory` with:
   - `enable_ptkn: true`
   - Optional `fee_bps_override`
2. **Confirm on-chain state**
   - `mint_mapping.has_ptkn == true`
   - `pool_state.twin_mint_enabled == true`
3. **Client rollout**
   - Set `NEXT_PUBLIC_CLUSTER` & other env to target the cluster
   - `ConvertForm` automatically exposes PTkn redemption when the mapping is enabled

**Rollback**
- Execute `update_mint` with `enable_ptkn: false`
- Confirm the UI no longer offers PTkn redemption

## 2. Enabling Post-Unshield and Post-Shield Hooks

**Purpose:** Turn on CPI hooks for relayer integration or downstream accounting.

**Steps**
1. **Prepare hook target program**
   - Deploy the hook program (`relayer-adapter` or custom)
   - Record required CPI accounts
2. **Execute governance instruction**
   - Call `configure_hooks` on `ptf_pool` with:
     - `post_shield_program_id`, `post_unshield_program_id`
     - `required_accounts`
     - `mode` (`Strict` or `Lenient`)
3. **Enable feature flag**
   - Call `set_features(pool, FEATURE_HOOKS_ENABLED)`
4. **Monitoring**
   - Subscribe to `PTFHookPostShield` / `PTFHookPostUnshield` events

**Rollback**
- Clear hook configuration via `configure_hooks` with default pubkeys
- Disable feature flag (`set_features` without `FEATURE_HOOKS_ENABLED`)

## 3. Pausing the Protocol

**Use case:** Security incident, halted relayer, or verifying-key rollover.

**Steps**
1. `ptf_factory::pause()` via governance
2. Broadcast notice to users (docs + status page)
3. Perform remediation
4. `ptf_factory::unpause()` when safe


# Relayer Roadmap

The relayer system remains optional, but interfaces are frozen so we can plug it in without migrations.

## Phase 1 — Intent Recording (On-chain)

1. Implement `relayer-adapter` program:
   - Registers `ShieldIntent` / `UnshieldIntent` via hooks
   - Stores claims in `ClaimQueue` PDAs
   - Emits events for off-chain relayers
2. Governance steps:
   - Deploy adapter
   - Configure hooks (section above)

## Phase 2 — Off-chain Relayer Service

1. REST API (reserved endpoints):
   - `POST /quote`
   - `POST /submit`
   - `GET /status/:intentId`
2. Intent signing:
   - Ed25519 signatures over canonical JSON
   - Intent hash matches PDA suffix (`["relayer-intent", origin_mint, intent_hash]`)
3. Execution:
   - Relayer reads intent queue, constructs transactions, submits with their own SOL
   - Optional payment via PTkn or stablecoin

## Phase 3 — Frontend Support (Optional)

1. Dynamic routes for quotes & submissions
2. UI for relayer selection, status polling, fallback flows


# Deployment Checklist (Governance & Relayer)

1. **Pre-launch**
   - Run Playwright E2E suite (`tests/e2e`) on local validator
   - Run program-test harness (pool, vault, factory)
2. **Activate PTkn (if required)**
   - Follow Section 1 above
   - Update docs & README cluster matrix
3. **Enable hooks (if relayer ready)**
   - Deploy adapter, configure hooks, and enable feature flag
   - Verify events and queue state
4. **Monitor**
   - Photon indexer metrics
   - Proof RPC logs (nullifier persistence, change outputs)
   - Vault dashboard invariants
5. **Rollback Strategy**
   - Pause via factory
   - Revoke hooks
   - Disable PTkn minting if necessary


# Next Steps After MVP

- Strengthen Proof RPC (rate limiting, API keys, Prometheus)
- Governance UI (status of feature flags, mint mapping, hook targets)
- Relayer adapter prototype + CLI tools
- Public-network faucet plan (testnet/mainnet)

