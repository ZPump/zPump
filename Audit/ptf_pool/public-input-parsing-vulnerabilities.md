# Public Input Parsing Vulnerabilities

## Severity: HIGH

## Description

The pool program parses public inputs from Groth16 proofs to extract roots, nullifiers, commitments, amounts, and fees. If parsing is incorrect or can be manipulated, security checks could be bypassed.

## Vulnerability Details

### Current Implementation

Public input parsing includes:
- `parse_field_elements`: Parses bytes into 32-byte field elements (lines 3449-3462)
- `validate_transfer_public_inputs`: Validates transfer public inputs (lines 3493-3605)
- `validate_unshield_public_inputs`: Validates unshield public inputs (lines 3800-3946)
- `decode_amount_from_field`: Decodes amounts from field elements (lines 3781-3784)

### Potential Vulnerabilities

1. **Buffer Overflow**: If bounds checking is insufficient, parsing could read beyond input bounds.

2. **Field Element Validation**: Field elements are not validated to ensure they're valid field values (within field modulus).

3. **Public Input Structure**: The expected structure of public inputs is complex and could be misinterpreted.

4. **Index Calculation Errors**: Incorrect index calculations could cause wrong fields to be read.

5. **Endianness Issues**: Field elements use little-endian encoding, but if encoding is inconsistent, values could be misinterpreted.

6. **Extra Fields Handling**: The code handles extra fields in unshield (lines 3935-3943), but validation might be insufficient.

7. **Length Validation**: While there are length checks, edge cases might not be handled correctly.

## Exploitation Scenario

```rust
// Scenario 1: Index calculation error
// 1. Attacker crafts proof with specific public input structure
// 2. Index calculation for nullifiers or commitments is off by one
// 3. Wrong values are read and validated
// 4. Security checks are bypassed

// Scenario 2: Extra fields manipulation
// 1. Attacker includes extra fields in public inputs
// 2. Extra field validation doesn't catch malicious values
// 3. Malicious values are used in operations
// 4. Security is compromised

// Scenario 3: Field element validation
// 1. Attacker includes invalid field elements (outside modulus)
// 2. Parsing doesn't validate field elements
// 3. Invalid values are used in calculations
// 4. Unexpected behavior or security bypass

// Scenario 4: Buffer overflow
// 1. Attacker provides malformed public inputs
// 2. Bounds checking is insufficient
// 3. Code reads beyond input bounds
// 4. Panic or incorrect behavior
```

## Code References

- Field element parsing: `parse_field_elements` (lines 3449-3462)
- Transfer validation: `validate_transfer_public_inputs` (lines 3493-3605)
- Unshield validation: `validate_unshield_public_inputs` (lines 3800-3946)
- Amount decoding: `decode_amount_from_field` (lines 3781-3784)
- Public input size limit: `MAX_PUBLIC_INPUTS_SIZE` (line 3447)

## Mitigation

1. **Comprehensive Bounds Checking**: Validate all array accesses and ensure indices are within bounds.

2. **Field Element Validation**: Validate that field elements are within the field modulus before use.

3. **Structure Validation**: Strictly validate the expected structure of public inputs before parsing.

4. **Index Calculation Verification**: Add assertions and validation for all index calculations.

5. **Extra Fields Rejection**: Reject or strictly validate any extra fields beyond the expected structure.

6. **Endianness Consistency**: Ensure consistent endianness handling throughout parsing.

7. **Input Sanitization**: Sanitize all parsed values before use in security-critical operations.

8. **Comprehensive Testing**: Add extensive tests for edge cases, malformed inputs, and boundary conditions.

## Recommended Code Changes

```rust
// Enhanced field element validation
fn validate_field_element(elem: &[u8; 32]) -> Result<()> {
    // Bn254 field modulus: p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
    // Field elements must be < p
    // For simplicity, we check that the element is not all 0xFF (which would be >= p)
    // More thorough validation would require full modulus comparison
    
    // Check for obviously invalid values
    if elem == &[0xFFu8; 32] {
        return err!(PoolError::InvalidFieldElement);
    }
    
    // Additional validation as needed
    Ok(())
}

// Enhanced parsing with validation
fn parse_field_elements(bytes: &[u8]) -> Result<Vec<[u8; 32]>> {
    require!(
        bytes.len() <= MAX_PUBLIC_INPUTS_SIZE,
        PoolError::PublicInputsTooLarge
    );
    require!(
        bytes.len() % 32 == 0,
        PoolError::InvalidPublicInputs
    );
    require!(
        bytes.len() >= 32, // At least one field element
        PoolError::InvalidPublicInputs
    );
    
    let mut elements = Vec::with_capacity(bytes.len() / 32);
    for chunk in bytes.chunks_exact(32) {
        let mut elem = [0u8; 32];
        elem.copy_from_slice(chunk);
        
        // Validate field element
        validate_field_element(&elem)?;
        
        elements.push(elem);
    }
    Ok(elements)
}

// Enhanced structure validation
fn validate_public_input_structure(
    fields: &[[u8; 32]],
    expected_min_len: usize,
    expected_max_len: Option<usize>,
) -> Result<()> {
    require!(
        fields.len() >= expected_min_len,
        PoolError::InvalidPublicInputs
    );
    
    if let Some(max_len) = expected_max_len {
        require!(
            fields.len() <= max_len,
            PoolError::InvalidPublicInputs
        );
    }
    
    Ok(())
}

// Enhanced transfer validation with structure check
fn validate_transfer_public_inputs(
    args: &TransferArgs,
    expected_mint: Pubkey,
    expected_pool: Pubkey,
) -> Result<()> {
    let fields = parse_field_elements(&args.public_inputs)?;
    
    // Calculate expected length
    let num_nullifiers = args.nullifiers.len();
    let num_outputs = args.output_commitments.len();
    let expected_len = 2 + num_nullifiers + num_outputs + 2; // old_root, new_root, nullifiers, outputs, mint, pool
    
    // Validate structure
    validate_public_input_structure(&fields, expected_len, Some(expected_len))?;
    
    // Validate each field with bounds checking
    // ... existing validation with additional bounds checks ...
    
    // Reject any extra fields (strict structure)
    require!(
        fields.len() == expected_len,
        PoolError::InvalidPublicInputs
    );
    
    Ok(())
}

// Enhanced amount decoding with validation
fn decode_amount_from_field(
    bytes: &[u8; 32],
    decimals: u8,
) -> Result<u64> {
    // Validate field element first
    validate_field_element(bytes)?;
    
    // Decode with validation
    let raw = field_bytes_to_u128_le(bytes);
    
    // Validate amount is reasonable (not too large)
    const MAX_REASONABLE_AMOUNT: u128 = 1_000_000_000_000_000; // 1 quadrillion
    require!(
        raw <= MAX_REASONABLE_AMOUNT,
        PoolError::AmountTooLarge
    );
    
    u64::try_from(raw).map_err(|_| error!(PoolError::AmountOverflow))
}
```

