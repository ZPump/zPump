# Validator Restart Instructions

## Current Status
- Validator started: 02:21 (running old binary)
- New binary built: 06:22 (MD5: c90f371e769b830a1637f9dae9dcb324)
- Validator loads programs via `--bpf-program` flags at startup

## Restart Methods

### Method 1: Systemd Service (Recommended)
```bash
sudo systemctl restart zpump-devnet
# Wait ~10 seconds for validator to start
solana -u http://127.0.0.1:8899 slot  # Verify it's running
```

### Method 2: Manual Process Restart
```bash
# Find validator PID
ps aux | grep solana-test-validator | grep -v grep

# Kill the process
kill <PID>

# Restart using your startup script
# (Check scripts/start-private-devnet.sh or systemd service)
```

### Method 3: Full Environment Reset
```bash
# If using reset-dev-env.sh script
./scripts/reset-dev-env.sh
```

## Verification
After restart, verify the new binary is loaded:
```bash
# Check program info
solana program show ESbKkBQ9P7pavvFPejBXhguBY3BSLtf1LyEQqBNRDHqb --url localhost

# Run tests
cd web/app && npx tsx scripts/test-prepare-execute.ts
```

## Expected Results After Restart
- ✅ Shield: Should continue passing
- ✅ TransferFrom: Should continue passing
- ✅ Unshield: Should now pass (access violation fixed)
- ✅ Transfer: Should now pass (access violation fixed)
- ⚠️ Batch operations: Code fixed, needs testing
