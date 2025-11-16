# Shared Library (`ptf_common`) Audit

## Observations

- The shared constants module is small and purely declarative; no critical security issues were identified.

## Suggestions

1. **Validate feature bits on input**  
   `FeatureFlags::from_bits`/`from(u8)` accept any bit pattern, so future callers can unknowingly enable undefined features:

```70:116:programs/common/src/lib.rs
#[derive(Clone, Copy, Debug, Default, AnchorSerialize, AnchorDeserialize, Eq, PartialEq)]
pub struct FeatureFlags(u8);
...
impl From<u8> for FeatureFlags {
    fn from(value: u8) -> FeatureFlags {
        FeatureFlags::from_bits(value)
    }
}
```
   Consider masking the incoming value against the set of supported bits so invalid configurations fail fast.

2. **Document seed usage**  
   The `seeds` module defines global PDA prefixes. Adding doc comments describing which program consumes each seed would help future audits trace ownership quickly.
