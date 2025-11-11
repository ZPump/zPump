use std::fs;
use std::path::PathBuf;

#[cfg(feature = "idl-build")]
fn main() {
    use anchor_lang::idl::IdlBuilder;

    // When executed manually this helper mirrors `anchor idl build` but keeps the legacy workflow.
    let program_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let idl = IdlBuilder::new()
        .program_path(program_dir.clone())
        .skip_lint(true)
        .build()
        .expect("build idl");
    let json = serde_json::to_string_pretty(&idl).expect("serialize idl");

    let out_dir = program_dir
        .join("..")
        .join("..")
        .join("target")
        .join("idl");
    fs::create_dir_all(&out_dir).expect("create idl directory");
    let path = out_dir.join("ptf_verifier_groth16.json");
    fs::write(&path, json).expect("write idl file");
    println!("wrote {}", path.display());
}

#[cfg(not(feature = "idl-build"))]
fn main() {
    eprintln!("Enable the `idl-build` feature to dump the IDL");
}
