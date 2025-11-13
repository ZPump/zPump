import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import poolIdl from '../idl/ptf_pool.json';

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
  const poolKey = new PublicKey(process.env.POOL_ID ?? 'EvtU1zyE4HtZ77VkpCNfEXGQnm5omr5dSNQjiY9jU66X');
  const accountInfo = await connection.getAccountInfo(poolKey);
  if (!accountInfo) {
    console.error('Pool account missing', poolKey.toBase58());
    process.exit(1);
  }
  const coder = new BorshCoder(poolIdl as Idl);
  const decoded = coder.accounts.decode('PoolState', accountInfo.data) as any;
  console.log({
    pool: poolKey.toBase58(),
    twinMintEnabled: decoded.twinMintEnabled,
    twinMint: decoded.twinMint?.toBase58?.() ?? decoded.twinMint,
    features: decoded.features,
    currentRoot: Buffer.from(decoded.currentRoot ?? []).toString('hex')
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
