# 2. Verifier: `groth16-dev-skip` bypass (Critical)

**Summary.** When compiled with `groth16-dev-skip`, `groth16_verify` unconditionally returns `true`, and the entrypoints only emit warnings. A misbuilt artifact therefore disables all proof checking in production.

**Mitigation plan.**
1. Add a runtime guard (e.g., `if cfg!(feature = "groth16-dev-skip") { panic!(...) }`) in both `initialize_verifying_key` and `verify_groth16` so production transactions fail immediately when the dev flag is set.
2. Strengthen CI/CD to compile release artifacts with `--features groth16-syscall` and explicitly deny `groth16-dev-skip` (for example, via `deny` in `Cargo.toml` or a build script that aborts if the wrong feature combination is detected).
3. Provide a unit test that ensures `groth16_verify` panics or errors when `dev-skip` is enabled under the `bpf` target to prevent regressions.
