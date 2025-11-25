const fs = require('fs');
const path = require('path');

const PENDING_SHIELD_DEF = {
  name: 'PendingShield',
  type: {
    kind: 'struct',
    fields: [
      { name: 'active', type: 'u8' },
      { name: 'old_root', type: { array: ['u8', 32] } },
      { name: 'new_root', type: { array: ['u8', 32] } },
      { name: 'commitment', type: { array: ['u8', 32] } },
      { name: 'amount_commit', type: { array: ['u8', 32] } },
      { name: 'amount', type: 'u64' },
      { name: 'depositor', type: 'pubkey' },
      { name: 'next_index', type: 'u64' }
    ]
  }
};

function patch(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn('IDL not found:', filePath);
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const idl = JSON.parse(raw);
  const types = Array.isArray(idl.types) ? idl.types : [];
  const hasType = types.some((entry) => entry.name === 'PendingShield');
  if (hasType) {
    console.log('PendingShield already present:', filePath);
    return;
  }
  idl.types = [...types, PENDING_SHIELD_DEF];
  fs.writeFileSync(filePath, JSON.stringify(idl, null, 2));
  console.log('Added PendingShield to', filePath);
}

const files = [
  path.join(__dirname, '..', 'target', 'idl', 'ptf_pool.json'),
  path.join(__dirname, '..', 'web', 'app', 'idl', 'ptf_pool.json')
];

files.forEach(patch);
