#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const circuits = require('./circuits.json');

const PTAU = path.join(__dirname, '..', 'pot', 'powersOfTau28_hez_final_20.ptau');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const KEYS_DIR = path.join(__dirname, '..', 'keys');

fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hashVerificationKey(jsonPath) {
  const data = fs.readFileSync(jsonPath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

const argv = yargs(hideBin(process.argv)).usage('$0 [name]').help().argv;
const filter = argv._[0];

const selected = filter ? circuits.filter((c) => c.name === filter) : circuits;
if (selected.length === 0) {
  console.error(`No circuit configuration found for filter "${filter}".`);
  process.exit(1);
}

if (!fs.existsSync(PTAU)) {
  console.error('Missing Powers of Tau. Run `npm run setup:ptau` first.');
  process.exit(1);
}

for (const circuit of selected) {
  const circuitDir = path.join(__dirname, '..');
  const entryPath = path.join(circuitDir, circuit.entry);
  const outDir = path.join(BUILD_DIR, circuit.name);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Compiling ${circuit.name} ===`);
  run('npx', ['circom', entryPath, '--wasm', '--r1cs', '--sym', '--output', outDir], circuitDir);

  console.log('Running Groth16 setup...');
  const r1csPath = path.join(outDir, circuit.r1cs);
  const zkeyInitial = path.join(outDir, `${circuit.name}_0000.zkey`);
  run('npx', ['snarkjs', 'groth16', 'setup', r1csPath, PTAU, zkeyInitial], circuitDir);

  const zkeyFinal = path.join(outDir, circuit.zkey);
  run('npx', [
    'snarkjs',
    'zkey',
    'beacon',
    zkeyInitial,
    zkeyFinal,
    circuit.beacon,
    '1',
    '0000000000000000000000000000000000000000000000000000000000000000'
  ], circuitDir);

  const vkPath = path.join(outDir, 'verification_key.json');
  run('npx', ['snarkjs', 'zkey', 'export', 'verificationkey', zkeyFinal, vkPath], circuitDir);

  const hash = hashVerificationKey(vkPath);
  fs.writeFileSync(path.join(outDir, 'verification_key.hash'), `${hash}\n`);

  const targetVkPath = path.join(KEYS_DIR, `${circuit.name}.json`);
  fs.copyFileSync(vkPath, targetVkPath);
  console.log(`Verification key exported (${hash}) → ${path.relative(circuitDir, targetVkPath)}`);
}
