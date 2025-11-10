#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PTAU_URL =
  'https://storage.googleapis.com/zkat-experiments/powersoftau/powersOfTau28_hez_final_20.ptau';
const PTAU_SHA256 = '93f3145d8133f11b8677d6b5c6b867b4099d5b6c0ee6f2d14a3cd59cab9492d1';
const targetDir = path.join(__dirname, '..', 'pot');
const targetPath = path.join(targetDir, 'powersOfTau28_hez_final_20.ptau');

fs.mkdirSync(targetDir, { recursive: true });

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('close', () => resolve(hash.digest('hex')));
  });
}

(async () => {
  if (fs.existsSync(targetPath)) {
    const digest = await hashFile(targetPath);
    if (digest === PTAU_SHA256) {
      console.log('Powers of Tau already present. Skipping download.');
      return;
    }
    console.warn('Existing Powers of Tau has unexpected hash. Re-downloading.');
  }

  console.log(`Downloading Powers of Tau from ${PTAU_URL}`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);
    https
      .get(PTAU_URL, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.unlinkSync(targetPath);
        reject(err);
      });
  });

  const digest = await hashFile(targetPath);
  if (digest !== PTAU_SHA256) {
    throw new Error(`Hash mismatch for Powers of Tau. Expected ${PTAU_SHA256}, got ${digest}`);
  }
  console.log('Powers of Tau downloaded and verified.');
})();
