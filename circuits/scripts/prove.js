#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const circomlibjs = require('circomlibjs');

const circuits = require('./circuits.json');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const INPUT_DIR = path.join(__dirname, '..', 'inputs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function bigIntify(value) {
  return BigInt(value);
}

function deriveShieldPublic(input) {
  const poseidon = circomlibjs.poseidon;
  const commitment = poseidon([
    bigIntify(input.amount),
    bigIntify(input.recipient_pk),
    bigIntify(input.deposit_id),
    bigIntify(input.pool_id),
    bigIntify(input.blinding)
  ]);
  const newRoot = poseidon([bigIntify(input.old_root), commitment]);
  return {
    commitment_hash: commitment.toString(),
    new_root: newRoot.toString()
  };
}

function deriveUnshieldPublic(input) {
  const poseidon = circomlibjs.poseidon;
  const nullifier = poseidon([
    bigIntify(input.note_id),
    bigIntify(input.spending_key)
  ]);
  const changeCommitment = poseidon([
    bigIntify(input.change_amount),
    bigIntify(input.change_recipient),
    bigIntify(input.mint_id),
    bigIntify(input.pool_id),
    bigIntify(input.change_blinding)
  ]);
  const changeAmountCommitment = poseidon([
    bigIntify(input.change_amount),
    bigIntify(input.change_amount_blinding)
  ]);
  const accumulator = poseidon([
    bigIntify(input.old_root),
    nullifier,
    changeCommitment,
    changeAmountCommitment
  ]);
  return {
    nullifier: nullifier.toString(),
    change_commitment: changeCommitment.toString(),
    change_amount_commitment: changeAmountCommitment.toString(),
    new_root: accumulator.toString()
  };
}

function mergeInputs(name, input) {
  if (name === 'shield') {
    return { ...input, ...deriveShieldPublic(input) };
  }
  if (name === 'unshield') {
    return { ...input, ...deriveUnshieldPublic(input) };
  }
  if (name === 'transfer') {
    const poseidon = circomlibjs.poseidon;
    const nullifier0 = poseidon([bigIntify(input.in_note_id_0), bigIntify(input.in_spending_key_0)]);
    const nullifier1 = poseidon([bigIntify(input.in_note_id_1), bigIntify(input.in_spending_key_1)]);
    const output0 = poseidon([
      bigIntify(input.out_amount_0),
      bigIntify(input.out_recipient_0),
      bigIntify(input.mint_id),
      bigIntify(input.pool_id),
      bigIntify(input.out_blinding_0)
    ]);
    const output1 = poseidon([
      bigIntify(input.out_amount_1),
      bigIntify(input.out_recipient_1),
      bigIntify(input.mint_id),
      bigIntify(input.pool_id),
      bigIntify(input.out_blinding_1)
    ]);
    const newRoot = poseidon([bigIntify(input.old_root), nullifier0, nullifier1]);
    return {
      ...input,
      nullifier_0: nullifier0.toString(),
      nullifier_1: nullifier1.toString(),
      output_commitment_0: output0.toString(),
      output_commitment_1: output1.toString(),
      new_root: newRoot.toString()
    };
  }
  return input;
}

const argv = yargs(hideBin(process.argv)).usage('$0 <name>').demandCommand(1).argv;
const name = argv._[0];
const circuit = circuits.find((c) => c.name === name);
if (!circuit) {
  console.error(`Unknown circuit: ${name}`);
  process.exit(1);
}

const circuitBuildDir = path.join(BUILD_DIR, circuit.name);
const witnessDir = path.join(circuitBuildDir, `${circuit.name}_js`);
const wasmPath = path.join(witnessDir, circuit.wasm ?? `${circuit.name}.wasm`);
const zkeyPath = path.join(circuitBuildDir, circuit.zkey);
const inputPath = path.join(INPUT_DIR, `${circuit.name}.json`);
const witnessPath = path.join(circuitBuildDir, 'witness.wtns');
const proofPath = path.join(circuitBuildDir, 'proof.json');
const publicPath = path.join(circuitBuildDir, 'public.json');

if (!fs.existsSync(zkeyPath)) {
  console.error(`Missing proving key for ${name}. Run \`npm run compile:${name}\` first.`);
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`Missing example input for ${name} at ${path.relative(process.cwd(), inputPath)}`);
  process.exit(1);
}

const userInput = JSON.parse(fs.readFileSync(inputPath));
const derivedInput = mergeInputs(name, userInput);
const derivedPath = path.join(circuitBuildDir, 'derived-input.json');
fs.writeFileSync(derivedPath, JSON.stringify(derivedInput, null, 2));

console.log(`Generating witness for ${name}...`);
run('node', [path.join(witnessDir, 'generate_witness.js'), wasmPath, derivedPath, witnessPath], witnessDir);

console.log('Creating Groth16 proof...');
run('npx', ['snarkjs', 'groth16', 'prove', zkeyPath, witnessPath, proofPath, publicPath], circuitBuildDir);

console.log(`Proof stored at ${path.relative(process.cwd(), proofPath)}`);
