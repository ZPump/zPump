# Security Audit: ptf_factory (Post-Fix Verification)

## Overview
The `ptf_factory` program manages mint mappings, creates twin mints, and handles timelock actions. Critical issues have been addressed with hash collision fixes, size limits, cleanup functions, and rate limiting.

## Security Vulnerabilities

### 1. **CRITICAL: Action Hash Validation Missing Salt in Execute** ✅ FIXED
**Severity:** CRITICAL  
**Location:** `execute_timelock_action()` function (line 416)  
**Status:** ✅ **VERIFIED FIXED**

**Fix Verification:**
Salt is now correctly included in hash recomputation: `&entry.salt,` (line 416)

### 2. **HIGH: No Rate Limiting on Timelock Actions** ✅ FIXED
**Severity:** HIGH  
**Location:** `queue_timelock_action()` function (lines 238-241, 314)  
**Status:** ✅ **VERIFIED FIXED**

**Fix Verification:**
- `last_action_time` field added to `FactoryState` (line 845)
- Rate limiting check before queue (lines 238-241)
- `last_action_time` updated after queue (line 314)
- `MIN_TIME_BETWEEN_ACTIONS = 60` seconds (line 851)

### 3. **HIGH: Timelock Entry Can Be Cleaned Up While Still Valid** ✅ FIXED
**Severity:** HIGH  
**Location:** `cleanup_timelock_action()` function (lines 526-545)  
**Status:** ✅ **VERIFIED FIXED**

**Fix Verification:**
- Checks `!entry.executed` and `!entry.canceled` before cleanup (lines 527-528)
- Validates cleanup threshold (execute_after + 30 days) (lines 537-545)

### 4. **MEDIUM: Factory State Migration Issue** 🔍 NEW
**Severity:** MEDIUM  
**Location:** `initialize_factory()` function (lines 28-55)  
**Status:** 🔍 **NEW ISSUE DISCOVERED**

**Description:**
If `FactoryState` already exists from a previous deployment, initialization will fail when trying to add the `last_action_time` field. Existing accounts won't have this field, causing deserialization errors.

**Impact:**
- Cannot upgrade existing factory deployments
- Breaking change requiring redeployment
- Loss of existing configuration

**Recommendation:**
Add migration instruction or handle missing field gracefully. See `AuditMitigation/03-FactoryStateMigration.md`.

### 5. **MEDIUM: Mint PTKN Doesn't Validate Pool Authority Is Signer in Context**
**Severity:** MEDIUM  
**Location:** `mint_ptkn()` function (lines 538-610)  
**Status:** ❌ **REMAINING**

**Description:**
The function checks `pool_authority.is_signer` but doesn't verify that the pool_authority provided in the accounts context is actually the signer. This relies on Anchor's constraint, but explicit validation would be clearer.

**Impact:**
- Potential confusion if accounts are misordered
- Relies on Anchor constraints rather than explicit checks

**Recommendation:**
Add explicit signer validation in the accounts struct constraint or in the instruction body.

### 6. **LOW: No Maximum Size Limit on Pending Action Hashes Vector**
**Severity:** LOW  
**Location:** `FactoryState` struct (line 842)  
**Status:** ❌ **REMAINING**

**Description:**
While `MAX_PENDING_ACTIONS` limits additions, the vector itself could theoretically grow if removals fail or are skipped. The space calculation accounts for 50 entries, but if the vector somehow exceeds this, account reallocation could fail.

**Impact:**
- Theoretical account size issues
- Very low probability

**Recommendation:**
Add explicit bounds checking when removing from vector to ensure it never exceeds MAX_PENDING_ACTIONS.

### 7. **LOW: Rate Limiting Affects All Authorities** 🔍 NEW
**Severity:** LOW  
**Location:** `queue_timelock_action()` function (line 239)  
**Status:** 🔍 **NEW ISSUE DISCOVERED**

**Description:**
Rate limiting is global per factory, not per authority. If multiple authorities exist (via upgrades), they share the same rate limit. One authority can block another by queuing actions rapidly.

**Impact:**
- One authority can block another
- Operational limitation if multi-authority support is planned

**Recommendation:**
Consider per-authority rate limiting if multi-authority support is planned.

