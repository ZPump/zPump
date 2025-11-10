#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node hash-verifying-key.js <path/to/verification_key.json>');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error(`File not found: ${abs}`);
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
console.log(hash);
