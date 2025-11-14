import { Metadata } from 'next';
import { ReactNode } from 'react';
import {
  Box,
  Code,
  Divider,
  Flex,
  Heading,
  ListItem,
  OrderedList,
  Stack,
  Text,
  UnorderedList
} from '@chakra-ui/react';
import { ArrowRight, ArrowDown } from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';

export const metadata: Metadata = {
  title: 'Whitepaper | zPump',
  description: 'A practical walkthrough of how the zPump protocol works on Solana.'
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={4}>
      <Heading size="lg">{title}</Heading>
      {children}
    </Stack>
  );
}

function DiagramNode({ title, body }: { title: string; body: string }) {
  return (
    <Box
      minW={{ base: '200px', md: '220px' }}
      bg="rgba(24, 20, 16, 0.9)"
      border="1px solid rgba(245,178,27,0.22)"
      rounded="2xl"
      p={4}
      textAlign="center"
      boxShadow="0 0 20px rgba(245, 178, 27, 0.18)"
    >
      <Heading size="sm" mb={2}>
        {title}
      </Heading>
      <Text fontSize="sm" color="whiteAlpha.700">
        {body}
      </Text>
    </Box>
  );
}

function DiagramArrow({ vertical = false }: { vertical?: boolean }) {
  return (
    <Flex align="center" justify="center">
      {vertical ? <ArrowDown size={24} /> : <ArrowRight size={24} />}
    </Flex>
  );
}

export default function WhitepaperPage() {
  return (
    <PageContainer maxW="6xl">
      <Stack spacing={12} py={10}>
        <Stack spacing={3}>
          <Text fontSize="sm" color="whiteAlpha.600">
            Version 1.1 • 2025-11-14
          </Text>
          <Heading size="2xl">zPump on Solana</Heading>
          <Heading size="md" fontWeight="medium" color="whiteAlpha.700">
            A practical guide to what zPump does, why it exists, and how you can build with it—no cryptography PhD required.
          </Heading>
        </Stack>

        <Section title="At a Glance">
          <Text>
            zPump lets any Solana token slip into a private mode without inventing a new coin. You deposit the public token into
            a program-controlled vault and receive a private note in the shielded pool. Inside the pool, movements are proven
            with zero-knowledge proofs so observers can’t learn who sent what. When you want to go public again, you unshield
            back to the original mint—or, if governance enables it, to a public twin that always stays 1:1 backed by the vault.
            That twin path is our migration ramp into Token-2022 Confidential Transfer (or future wrapped rails): the vault keeps
            custody of the origin mint while governance can mint a CT-capable twin that mirrors supply exactly. The system now
            runs its full security profile (Merkle digests, note digests, and invariant checks) inside Solana’s 1.4M compute unit
            budget thanks to a SHA-256 commitment tree and a staged finalize pipeline. Relayer hooks remain wired in for future
            upgrades.
          </Text>
        </Section>

        <Section title="Why It Matters">
          <Text>
            Solana is fantastic for openness and auditability—but that also exposes salaries, supplier deals, and strategic
            moves to the world. zPump gives people the choice to move privately when they need to, and to step back into public
            markets when they are ready. It is not a new chain or a wrapped token ecosystem; it is a privacy room connected to
            the assets you already use.
          </Text>
        </Section>

        <Section title="How zPump Is Put Together">
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
              Maintains notes, nullifiers, SHA-256 Merkle roots, and verifies zero-knowledge proofs.
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
          <Stack spacing={6} mt={6}>
            <Heading size="md">Flow at a glance</Heading>
            <Stack spacing={8} align="center">
              <Stack
                direction={{ base: 'column', md: 'row' }}
                spacing={4}
                align="center"
                justify="center"
                w="100%"
              >
                <DiagramNode title="User Wallet" body="Holds the public token and triggers shield/unshield actions." />
                <DiagramArrow />
                <DiagramNode
                  title="Vault"
                  body="Program-owned account that escrows origin tokens while they are private."
                />
                <DiagramArrow />
                <DiagramNode
                  title="Shielded Pool"
                  body="Maintains commitments, nullifiers, and Merkle roots; verifies zero-knowledge proofs."
                />
                <DiagramArrow />
                <DiagramNode
                  title="Wallet (public again)"
                  body="Receives the original token or—if enabled—a public version that stays 1:1 backed in the vault."
                />
              </Stack>
            </Stack>
          </Stack>
        </Section>

        <Section title="Core Concepts">
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
                ShieldClaim:
              </Text>{' '}
              A PDA that tracks an in-flight shield through finalize_tree → finalize_ledger → invariant_check so multi-transaction flows stay atomic.
            </ListItem>
            <ListItem>
              <Text as="span" fontWeight="semibold">
                Invariant:
              </Text>{' '}
              Vault balance of M = Supply of P(M) + Live private notes − Protocol fees. The final finalize step enforces this.
            </ListItem>
          </UnorderedList>
        </Section>

        <Section title="What Stays Private (and What Doesn’t)">
          <UnorderedList spacing={2}>
            <ListItem>Inside the pool: sender, receiver, and amount are hidden.</ListItem>
            <ListItem>Edges remain public by design: shield and unshield events show token, amount, and wallet.</ListItem>
            <ListItem>MVP does not hide DEX activity—once public, you are public.</ListItem>
            <ListItem>Relayer support is future work; hooks already exist but are disabled.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="Optimized Math Path">
          <Text>
            Circuit commitments still use Poseidon and Groth16 proofs over BN254, but the on-chain tree now runs entirely on
            SHA-256 syscalls. Proofs expose canonical commitment bytes so the program can derive the SHA leaf deterministically.
            That swap, plus chunked tree updates replaced by a dedicated SHA pipeline, shaved the largest compute hotspot.
            Nullifiers still guarantee each note spends once, and commitments remain the cryptographic envelope for value plus
            recipient key plus randomness.
        </Section>

        <Section title="User Flows">
          <Heading size="md">Shield (public → private)</Heading>
          <OrderedList spacing={2} pl={4}>
            <ListItem>Pick origin mint M and an amount.</ListItem>
            <ListItem>Wallet sends M to Vault(M) while starting a `ShieldClaim`.</ListItem>
            <ListItem>
              Finalize in three lightweight steps: update the SHA-256 tree, post ledger entries/hooks, then enforce the supply
              invariant. Each phase can live in its own transaction while the claim keeps state.
            </ListItem>
          </OrderedList>

          <Heading size="md">Private transfer (optional in MVP)</Heading>
          <OrderedList spacing={2} pl={4}>
            <ListItem>Select notes to spend and recipients for new notes.</ListItem>
            <ListItem>Generate a transfer proof showing inputs exist, are unspent, and totals balance.</ListItem>
            <ListItem>Pool verifies, records new notes, and marks old ones spent via nullifiers.</ListItem>
          </OrderedList>

          <Heading size="md">Unshield (private → public)</Heading>
          <UnorderedList spacing={2}>
            <ListItem>To Origin: prove ownership of notes; pool instructs Vault to release M (minus fees).</ListItem>
            <ListItem>
              To Twin: receive P(M) 1:1 in the public wallet for open trading or migration into Token-2022 Confidential Transfer
              while the origin mint stays parked in the vault.
            </ListItem>
          </UnorderedList>
        </Section>

        <Section title="Design Choices Already Locked In">
          <UnorderedList spacing={2}>
            <ListItem>Proof system: Groth16 on BN254.</ListItem>
            <ListItem>Hashing: Poseidon inside circuits; SHA-256 on-chain Merkle (depth 32).</ListItem>
            <ListItem>Fees: default 5 bps on shield and unshield, none on private transfers.</ListItem>
            <ListItem>Programs: factory, vault, pool, verifier-groth16.</ListItem>
            <ListItem>Twin tokens optional; decimals mirror origin; factory owns mint authority.</ListItem>
            <ListItem>Hooks exist for relayers but are off by default.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="Build Map for Developers">
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

        <Section title="Safety Rails & Governance">
          <UnorderedList spacing={2}>
            <ListItem>Invariant must hold every exit; otherwise the transaction aborts.</ListItem>
            <ListItem>Nullifiers prevent double spends.</ListItem>
            <ListItem>Pause switch can halt new shields/unshields without risking funds.</ListItem>
            <ListItem>Upgrades via DAO multisig + timelock; verifying keys treated as immutable.</ListItem>
            <ListItem>Indexer data is untrusted; wallets verify against on-chain roots.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="What zPump Doesn’t Solve (Yet)">
          <UnorderedList spacing={2}>
            <ListItem>No invisibility outside the pool—public activity stays public.</ListItem>
            <ListItem>No supply magic—every private unit is backed by Vault tokens.</ListItem>
            <ListItem>No forced KYC in core protocol; compliance layers are optional add-ons.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="Roadmap">
          <OrderedList spacing={2} pl={4}>
            <ListItem>MVP: shield/unshield (origin and optional twin); private transfers gated by feature flag.</ListItem>
            <ListItem>Post-MVP: enable private transfers by default, faster proving, better wallet UX.</ListItem>
            <ListItem>Relayer: enable hooks via governance and deploy relayer-adapter for sponsored fees or batched exits.</ListItem>
            <ListItem>
              Token-2022 bridge: once Solana confidential features mature, offer migration without losing full privacy.
            </ListItem>
          </OrderedList>
        </Section>

        <Section title="Glossary">
          <UnorderedList spacing={2}>
            <ListItem>ATA (Associated Token Account): standard SPL token account per wallet.</ListItem>
            <ListItem>Commitment: sealed value of a note.</ListItem>
            <ListItem>Groth16: succinct zero-knowledge proof system used in zPump.</ListItem>
            <ListItem>Merkle root: fingerprint of the entire note tree.</ListItem>
            <ListItem>Nullifier: one-time tag that prevents spending a note twice.</ListItem>
            <ListItem>Relayer: optional future service triggered by hooks.</ListItem>
          </UnorderedList>
        </Section>

        <Section title="Reference Details">
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
              <Code>full_tree</Code>, <Code>note_digests</Code>, and <Code>invariant_checks</Code> ship enabled by default; `lightweight`
              builds live on as a regression profile only.
            </ListItem>
            <ListItem>
              <Code>0x01</Code> → PRIVATE_TRANSFER_ENABLED
            </ListItem>
            <ListItem>
              <Code>0x02</Code> → HOOKS_ENABLED
            </ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Events emitted:</Text>
          <UnorderedList spacing={2}>
            <ListItem>{'Shielded {mint,depositor,commitment,root,amount_commit}'}</ListItem>
            <ListItem>{'Transferred {mint,nullifiers:[...],commitments:[...],root}'}</ListItem>
            <ListItem>{'UnshieldOrigin {mint,dest,amount,fee}'}</ListItem>
            <ListItem>{'UnshieldTwin {mint,dest,amount,fee}'}</ListItem>
          </UnorderedList>
          <Text fontWeight="semibold">Default parameters:</Text>
          <UnorderedList spacing={2}>
            <ListItem>Merkle depth: 32 (SHA-256 on-chain)</ListItem>
            <ListItem>Hash (circuit commitments): Poseidon</ListItem>
            <ListItem>Proof system: Groth16 (BN254)</ListItem>
            <ListItem>Fee: 5 bps on shield/unshield</ListItem>
            <ListItem>Hooks: disabled by default</ListItem>
          </UnorderedList>
        </Section>

        <Section title="Closing Thought">
          <Text>
            Think of zPump as a privacy side room connected to the tokens you already own. The public chain stays public, but
            you can step into a quieter space when you need it—without creating a new currency or trusting a middleman. The
            launch version keeps things conservative, yet the architecture is ready for faster proofs, relayers, and deeper
            integrations as the ecosystem matures.
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

