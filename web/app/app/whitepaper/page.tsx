'use client';

import { Metadata } from 'next';
import {
  Box,
  Code,
  Divider,
  Heading,
  ListItem,
  OrderedList,
  Stack,
  Text,
  UnorderedList
} from '@chakra-ui/react';
import { PageContainer } from '../../components/PageContainer';

export const metadata: Metadata = {
  title: 'Whitepaper | zPump',
  description: 'A practical walkthrough of how the zPump protocol works on Solana.'
};

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Stack spacing={4}>
      <Heading size="lg">{title}</Heading>
      {children}
    </Stack>
  );
}

export default function WhitepaperPage() {
  return (
    <PageContainer maxW="6xl">
      <Stack spacing={12} py={10}>
        <Stack spacing={3}>
          <Text fontSize="sm" color="whiteAlpha.600">
            Version 1.0 • 2025-11-09
          </Text>
          <Heading size="2xl">zPump on Solana</Heading>
          <Heading size="md" fontWeight="medium" color="whiteAlpha.700">
            What this is: a clear, practical guide to how the protocol works and why it matters—simple enough for a first-year
            CS student, detailed enough to build from.
          </Heading>
        </Stack>

        <Section title="1) One-Paragraph Summary">
          <Text>
            zPump adds a private mode to any existing Solana token. You deposit the public token into a program-controlled Vault
            and receive a private balance inside a Shielded Pool. Inside the pool, value moves with zero-knowledge proofs so
            outsiders cannot see who sent what or how much. When you are ready to go public, you unshield back to the origin
            mint—or, if enabled, to a public twin token that stays backed 1:1 by the Vault. The MVP ships without a relayer,
            but clean hooks make it easy to plug one in later without breaking anything.
          </Text>
        </Section>

        <Section title="2) Why It Matters">
          <Text>
            Public blockchains are fantastic for auditability but terrible for privacy: salaries, supplier prices, donations,
            and strategy leaks are trivial to trace. zPump gives users and businesses a choice—move privately when needed, go
            public when convenient. No new chain, no new coin: it is a privacy room tacked onto the tokens you already use.
          </Text>
        </Section>

        <Section title="3) High-Level Architecture">
          <Text fontWeight="semibold">On-chain programs:</Text>
          <UnorderedList spacing={2}>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Factory:
              </Text>{' '}
              Registers which origin mint (M) optionally has a public twin P(M) and holds P(M) mint authority.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Vault:
              </Text>{' '}
              Custodies the public tokens while balances are private.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Shielded Pool:
              </Text>{' '}
              Maintains notes, nullifiers, Merkle roots, and verifies zero-knowledge proofs.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Verifier:
              </Text>{' '}
              A compact Groth16 verifier optimized for Solana.
            </ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Off-chain support (optional but useful):</Text>
          <UnorderedList spacing={2}>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Indexer:
              </Text>{' '}
              Reconstructs compressed data so wallets can render roots, notes, and nullifiers.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Proof RPC:
              </Text>{' '}
              Helps light clients generate Groth16 proofs without holding funds.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Relayer (future):
              </Text>{' '}
              Disabled in MVP, but hook targets are reserved.
            </ListItem>
          </UnorderedList>
          <Box
            as="pre"
            fontSize="sm"
            border="1px solid rgba(255,255,255,0.1)"
            rounded="lg"
            p={4}
            bg="rgba(10,14,30,0.85)"
            whiteSpace="pre-wrap"
          >
            {`flowchart LR
U[User Wallet] -->|Shield (deposit origin token M)| V[Vault(M)]
V -->|Create private note| S[Shielded Pool S(M)]
S -->|Private transfers (optional)| S
S -->|Unshield -> Origin (M)| U
S -->|Unshield -> P(M) (optional)| U
S -. post_shield_hook .-> H1[[Hook Target (future relayer)]]
S -. post_unshield_hook .-> H2[[Hook Target (future relayer)]]`}
          </Box>
        </Section>

        <Section title="4) Core Ideas">
          <UnorderedList spacing={2}>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Shield:
              </Text>{' '}
              Move public tokens into the Vault and mint a private note in the pool.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Private transfer:
              </Text>{' '}
              Spend notes and create new ones using a zero-knowledge proof instead of exposing addresses or amounts.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Unshield:
              </Text>{' '}
              Burn notes with a proof and receive either M or P(M).
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Invariant:
              </Text>{' '}
              Vault balance of M = Supply of P(M) + Live private notes − Protocol fees. Every exit checks this.
            </ListItem>
          </UnorderedList>
        </Section>

        <Section title="5) Privacy Model">
          <UnorderedList spacing={2}>
            <ListItem>Inside the pool: sender, receiver, and amount are hidden.</ListItem>
            <ListItem>Edges remain public by design: shield and unshield events show token, amount, and wallet.</ListItem>
            <ListItem>MVP does not hide DEX activity—once public, you are public.</ListItem>
            <ListItem>Relayer support is future work; hooks already exist but are disabled.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="6) Minimum Math">
          <Text>
            zPump relies on Poseidon hashing, Groth16 proofs over BN254, and a depth-32 Merkle tree. A nullifier guarantees
            each note spends once; a commitment is the cryptographic envelope for value plus recipient key plus randomness.
          </Text>
        </Section>

        <Section title="7) User Flows">
          <Heading size="md">7.1 Shield (Public → Private)</Heading>
          <OrderedList spacing={2} pl={4}>
            <ListItem>Pick origin mint M and an amount.</ListItem>
            <ListItem>Wallet sends M to Vault(M).</ListItem>
            <ListItem>App builds a shield proof; the pool verifies it and records the private note.</ListItem>
          </OrderedList>

          <Heading size="md">7.2 Private Transfer (optional in MVP)</Heading>
          <OrderedList spacing={2} pl={4}>
            <ListItem>Select notes to spend and recipients for new notes.</ListItem>
            <ListItem>Generate a transfer proof showing inputs exist, are unspent, and totals balance.</ListItem>
            <ListItem>Pool verifies, records new notes, and marks old ones spent via nullifiers.</ListItem>
          </OrderedList>

          <Heading size="md">7.3 Unshield (Private → Public)</Heading>
          <UnorderedList spacing={2}>
            <ListItem>To Origin: prove ownership of notes; pool instructs Vault to release M (minus fees).</ListItem>
            <ListItem>To Twin: receive P(M) 1:1 in the public wallet for open trading.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="8) Decisions Already Made">
          <UnorderedList spacing={2}>
            <ListItem>Proof system: Groth16 on BN254.</ListItem>
            <ListItem>Hashing: Poseidon; Merkle depth 32.</ListItem>
            <ListItem>Fees: default 5 bps on shield and unshield, none on private transfers.</ListItem>
            <ListItem>Programs: factory, vault, pool, verifier-groth16.</ListItem>
            <ListItem>Twin tokens optional; decimals mirror origin; factory owns mint authority.</ListItem>
            <ListItem>Hooks exist for relayers but are off by default.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="9) Build Map for Developers">
          <UnorderedList spacing={2}>
            <ListItem>Factory program: map origin mints, hold twin mint authority, manage config.</ListItem>
            <ListItem>Vault program: custody and controlled release of origin tokens.</ListItem>
            <ListItem>Pool program: verify proofs, track roots/nullifiers, enforce invariant, mint twins.</ListItem>
            <ListItem>Verifier program: expose `verify_groth16` instruction.</ListItem>
            <ListItem>Web app: Next.js + wallet adapters with client-side proving (WebWorker/WebGPU).</ListItem>
            <ListItem>Indexer: Photon or self-hosted service for commitments/nullifiers.</ListItem>
            <ListItem>Proof RPC: optional stateless prover.</ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Helpful SDK calls:</Text>
          <Box as="pre" fontSize="sm" bg="rgba(10,14,30,0.85)" p={4} rounded="lg" border="1px solid rgba(255,255,255,0.1)">
            {`shield(connection, wallet, originMint, amount, recipientViewKey)
privateTransfer(connection, wallet, inputs, outputs) // behind feature flag
unshieldToOrigin(connection, wallet, originMint, amount, destination?)
unshieldToTwin(connection, wallet, originMint, amount, destination?)
getRoots(connection, originMint)
getNullifiers(connection, originMint)
scanNotes(connection, viewKey, originMint?)`}
          </Box>
        </Section>

        <Section title="10) Safety & Governance">
          <UnorderedList spacing={2}>
            <ListItem>Invariant must hold every exit; otherwise the transaction aborts.</ListItem>
            <ListItem>Nullifiers prevent double spends.</ListItem>
            <ListItem>Pause switch can halt new shields/unshields without risking funds.</ListItem>
            <ListItem>Upgrades via DAO multisig + timelock; verifying keys treated as immutable.</ListItem>
            <ListItem>Indexer data is untrusted; wallets verify against on-chain roots.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="11) What It Does Not Do">
          <UnorderedList spacing={2}>
            <ListItem>No invisibility outside the pool—public activity stays public.</ListItem>
            <ListItem>No supply magic—every private unit is backed by Vault tokens.</ListItem>
            <ListItem>No forced KYC in core protocol; compliance layers are optional add-ons.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="12) Roadmap">
          <OrderedList spacing={2} pl={4}>
            <ListItem>MVP: shield/unshield (origin and optional twin); private transfers gated by feature flag.</ListItem>
            <ListItem>Post-MVP: enable private transfers by default, faster proving, better wallet UX.</ListItem>
            <ListItem>Relayer: enable hooks via governance and deploy relayer-adapter for sponsored fees or batched exits.</ListItem>
            <ListItem>
              Token-2022 bridge: once Solana confidential features mature, offer migration without losing full privacy.
            </ListItem>
          </OrderedList>
        </Section>

        <Section title="13) Glossary">
          <UnorderedList spacing={2}>
            <ListItem>ATA (Associated Token Account): standard SPL token account per wallet.</ListItem>
            <ListItem>Commitment: sealed value of a note.</ListItem>
            <ListItem>Groth16: succinct zero-knowledge proof system used in zPump.</ListItem>
            <ListItem>Merkle root: fingerprint of the entire note tree.</ListItem>
            <ListItem>Nullifier: one-time tag that prevents spending a note twice.</ListItem>
            <ListItem>Relayer: optional future service triggered by hooks.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="14) Reference Details">
          <Text fontWeight="semibold">Key PDA seeds:</Text>
          <Box as="pre" fontSize="sm" bg="rgba(10,14,30,0.85)" p={4} rounded="lg" border="1px solid rgba(255,255,255,0.1)">
            {`FactoryState: ["factory", <factory_program_id>]
MintMapping: ["map", <origin_mint>]
Vault: ["vault", <origin_mint>]
PoolState: ["pool", <origin_mint>]
HookConfig: ["hooks", <origin_mint>]
VerifyingKey: ["vk", <circuit_tag>, <version>]
NullifierSet: ["nulls", <origin_mint>]`}
          </Box>
          <Text fontWeight="semibold">Feature flags (PoolState.features):</Text>
          <UnorderedList spacing={2}>
            <ListItem>
              <Code>0x01</Code> → PRIVATE_TRANSFER_ENABLED
            </ListItem>
            <ListItem>
              <Code>0x02</Code> → HOOKS_ENABLED
            </ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Events emitted:</Text>
          <UnorderedList spacing={2}>
            <ListItem>Shielded {{'{'}}mint,depositor,commitment,root,amount_commit{{'}'}}</ListItem>
            <ListItem>Transferred {{'{'}}mint,nullifiers:[...],commitments:[...],root{{'}'}}</ListItem>
            <ListItem>UnshieldOrigin {{'{'}}mint,dest,amount,fee{{'}'}}</ListItem>
            <ListItem>UnshieldTwin {{'{'}}mint,dest,amount,fee{{'}'}}</ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Default parameters:</Text>
          <UnorderedList spacing={2}>
            <ListItem>Merkle depth: 32</ListItem>
            <ListItem>Hash: Poseidon</ListItem>
            <ListItem>Proof system: Groth16 (BN254)</ListItem>
            <ListItem>Fee: 5 bps on shield/unshield</ListItem>
            <ListItem>Hooks: disabled by default</ListItem>
          </UnorderedList>
        </Section>

        <Section title="15) Closing Thought">
          <Text>
            Think of zPump as a privacy add-on for the tokens you already hold. The public chain stays public, but you get a
            private room when you need one—without inventing a new currency or trusting a middleman. The first release stays
            conservative, yet the design is future-proofed to grow with Solana.
          </Text>
        </Section>

        <Divider borderColor="whiteAlpha.200" />
        <Text fontSize="sm" color="whiteAlpha.600">
          Questions or feedback? Open an issue in the repository or reach out to the core team.
        </Text>
      </Stack>
    </PageContainer>
  );
}

