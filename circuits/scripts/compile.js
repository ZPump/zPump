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
  run(
    'npx',
    ['circom', entryPath, '--wasm', '--r1cs', '--sym', '--output', outDir],
    circuitDir
  );

  const defaultR1cs = path.join(outDir, 'circuit.r1cs');
  const targetR1cs = path.join(outDir, circuit.r1cs);
  if (fs.existsSync(defaultR1cs)) {
    fs.renameSync(defaultR1cs, targetR1cs);
  }

  const defaultSym = path.join(outDir, 'circuit.sym');
  if (fs.existsSync(defaultSym)) {
    fs.renameSync(defaultSym, path.join(outDir, `${circuit.name}.sym`));
  }

  const wasmDir = path.join(outDir, 'circuit_js');
  const defaultWasm = path.join(wasmDir, 'circuit.wasm');
  const targetWasm = path.join(outDir, circuit.wasm);
  if (fs.existsSync(defaultWasm)) {
    fs.copyFileSync(defaultWasm, targetWasm);
  }

  console.log('Running Groth16 setup...');
  const r1csPath = targetR1cs;
  const zkeyInitial = path.join(outDir, `${circuit.name}_0000.zkey`);
  run('npx', ['snarkjs', 'groth16', 'setup', r1csPath, PTAU, zkeyInitial], circuitDir);

  const zkeyFinal = path.join(outDir, circuit.zkey);
  const beaconHash = crypto.createHash('sha256').update(circuit.beacon).digest('hex');
  run('npx', [
    'snarkjs',
    'zkey',
    'beacon',
    zkeyInitial,
    zkeyFinal,
    beaconHash,
    '10'
  ], circuitDir);

  const vkPath = path.join(outDir, 'verification_key.json');
  run('npx', ['snarkjs', 'zkey', 'export', 'verificationkey', zkeyFinal, vkPath], circuitDir);

  const hash = hashVerificationKey(vkPath);
  fs.writeFileSync(path.join(outDir, 'verification_key.hash'), `${hash}\n`);

  const targetVkPath = path.join(KEYS_DIR, `${circuit.name}.json`);
  fs.copyFileSync(vkPath, targetVkPath);
  console.log(
    `Verification key exported (${hash}) → ${path.relative(circuitDir, targetVkPath)}`
  );

  const targetZkeyPath = path.join(KEYS_DIR, `${circuit.name}.zkey`);
  fs.copyFileSync(zkeyFinal, targetZkeyPath);

  const wasmOutputDir = path.join(__dirname, '..', 'wasm');
  fs.mkdirSync(wasmOutputDir, { recursive: true });
  if (fs.existsSync(targetWasm)) {
    fs.copyFileSync(targetWasm, path.join(wasmOutputDir, circuit.wasm));
  }
}
