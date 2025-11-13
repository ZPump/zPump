import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import factoryIdl from '../idl/ptf_factory.json';

async function main() {
  const connection = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
  const originMint = new PublicKey(process.env.ORIGIN_MINT ?? 'Aw5iYNvtWZuTUJ4k5pfJ3Mtf7QrQcPJ6uK4XV9AhaSBm');
  const factoryProgram = new PublicKey('4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy');
  const mappingKey = PublicKey.findProgramAddressSync([Buffer.from('map'), originMint.toBuffer()], factoryProgram)[0];
  const accountInfo = await connection.getAccountInfo(mappingKey);
  if (!accountInfo) {
    console.error('Mint mapping account missing', mappingKey.toBase58());
    process.exit(1);
  }
  const coder = new BorshCoder(factoryIdl as Idl);
  const decoded = coder.accounts.decode('MintMapping', accountInfo.data) as any;
  const ptknMintField = decoded.ptkn_mint ?? decoded.ptknMint;
  const ptknMint = ptknMintField instanceof PublicKey ? ptknMintField : new PublicKey(ptknMintField);
  const hasPtkn = decoded.has_ptkn ?? decoded.hasPtkn;
  console.log({
    mintMapping: mappingKey.toBase58(),
    hasPtkn,
    ptknMint: ptknMint.toBase58(),
    features: decoded.features
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
