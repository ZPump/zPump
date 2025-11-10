#!/usr/bin/env node
const semver = require('semver');
const { engines } = require('../package.json');

const required = engines?.node ?? '>=18.18.0';
if (!semver.satisfies(process.version, required)) {
  console.error(`PTF circuits require Node.js ${required}. Detected ${process.version}.`);
  process.exit(1);
}
