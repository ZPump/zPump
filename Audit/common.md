# Common Library Audit

The `ptf-common` crate only defines shared constants, feature-flag helpers, PDA seeds, and error enums. It does **not** own any accounts or perform privileged mutations, so no direct on-chain attack surface was identified. Keep the following hygiene practices in mind:

- Treat `FeatureFlags` additions as part of the public API and document new bits so downstream programs can decode them safely.
- When modifying PDA seed constants, update every program that derives those addresses to avoid desynchronization bugs.

No actionable vulnerabilities were identified in this helper crate during the review.
