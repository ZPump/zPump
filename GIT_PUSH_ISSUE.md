# Git Push Issue - Large Files in History

## Problem
Push to GitHub is blocked because commit `09d5764` contains large files:
- `test-ledger/rocksdb/000031.sst` (253.84 MB)
- `test-ledger/rocksdb/000033.sst` (251.70 MB)

GitHub has a 100MB file size limit.

## Solution Options

### Option 1: Use BFG Repo-Cleaner (Recommended)
```bash
# Install Java first if needed
sudo apt install openjdk-11-jdk

# Download BFG
wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar

# Create backup
git clone --mirror . /tmp/zPump-backup.git

# Remove large files
java -jar bfg-1.14.0.jar --delete-files "test-ledger/rocksdb/000031.sst" --delete-files "test-ledger/rocksdb/000033.sst" /tmp/zPump-backup.git

# Clean up
cd /tmp/zPump-backup.git
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Replace your repo
cd /home/hendo420/zPump
git remote remove backup 2>/dev/null
git remote add backup /tmp/zPump-backup.git
git fetch backup
git reset --hard backup/main
git push --force-with-lease origin main
```

### Option 2: Use git-filter-repo
```bash
# Install git-filter-repo
pip3 install git-filter-repo

# Remove large files
git filter-repo --path test-ledger/rocksdb/000031.sst --invert-paths
git filter-repo --path test-ledger/rocksdb/000033.sst --invert-paths

# Force push
git push --force-with-lease origin main
```

### Option 3: Create Fresh Branch (Simpler but loses some history)
```bash
# Create new branch from origin/main
git checkout origin/main
git checkout -b main-clean

# Cherry-pick commits you need (excluding 09d5764 or modify it)
# Then force push
git push --force-with-lease origin main-clean:main
```

## Current Status
- ✅ All code changes are committed locally
- ✅ `.gitignore` updated to prevent future test-ledger additions
- ⚠️ Push blocked until history is cleaned

## Commits Ready to Push
- `3b21e92` - Add test-ledger to gitignore
- `8f75a1e` - Fix UserProofVault serialization format
- `c6f96e6` - Debug execute_shield_v2 AccountDataTooShort
- `44aa2f3` - Clean up test-ledger references

