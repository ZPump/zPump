use std::fs;
use std::path::Path;

fn main() {
    let idl = ptf_verifier_groth16::idl();
    let json = serde_json::to_string_pretty(&idl).expect("serialize idl");
    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("target")
        .join("idl");
    fs::create_dir_all(&out_dir).expect("create idl directory");
    let path = out_dir.join("ptf_verifier_groth16.json");
    fs::write(&path, json).expect("write idl file");
    println!("wrote {}", path.display());
}

