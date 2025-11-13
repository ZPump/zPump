use std::{env, fs, path::PathBuf, process::ExitCode};

use ark_bn254::{Bn254, Fq, Fq2, G1Affine, G2Affine};
use ark_groth16::VerifyingKey;
use ark_serialize::CanonicalSerialize;
use serde::Deserialize;
use std::str::FromStr;

#[derive(Deserialize)]
struct VerificationKeyJson {
    vk_alpha_1: [String; 3],
    vk_beta_2: [[String; 2]; 3],
    vk_gamma_2: [[String; 2]; 3],
    vk_delta_2: [[String; 2]; 3],
    #[serde(rename = "IC")]
    ic: Vec<[String; 3]>,
}

fn parse_fq(value: &str) -> Fq {
    Fq::from_str(value).expect("invalid field element")
}

fn parse_g1(coords: &[String; 3]) -> G1Affine {
    let x = parse_fq(&coords[0]);
    let y = parse_fq(&coords[1]);
    G1Affine::new_unchecked(x, y)
}

fn parse_g2(coords: &[[String; 2]; 3]) -> G2Affine {
    let x = Fq2::new(parse_fq(&coords[0][0]), parse_fq(&coords[0][1]));
    let y = Fq2::new(parse_fq(&coords[1][0]), parse_fq(&coords[1][1]));
    G2Affine::new_unchecked(x, y)
}

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let input = match args.next() {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!("Usage: cargo run --bin export_vk <path/to/verification_key.json> [output.bin]");
            return ExitCode::FAILURE;
        }
    };

    let output = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| input.with_extension("bin"));

    let contents = match fs::read_to_string(&input) {
        Ok(data) => data,
        Err(err) => {
            eprintln!("Failed to read {}: {err}", input.display());
            return ExitCode::FAILURE;
        }
    };

    let vk_json: VerificationKeyJson = match serde_json::from_str(&contents) {
        Ok(json) => json,
        Err(err) => {
            eprintln!("Failed to parse JSON {}: {err}", input.display());
            return ExitCode::FAILURE;
        }
    };

    let gamma_abc: Vec<G1Affine> = vk_json.ic.iter().map(|coords| parse_g1(coords)).collect();

    let verifying_key = VerifyingKey::<Bn254> {
        alpha_g1: parse_g1(&vk_json.vk_alpha_1),
        beta_g2: parse_g2(&vk_json.vk_beta_2),
        gamma_g2: parse_g2(&vk_json.vk_gamma_2),
        delta_g2: parse_g2(&vk_json.vk_delta_2),
        gamma_abc_g1: gamma_abc,
    };

    let mut bytes = Vec::new();
    if verifying_key
        .serialize_uncompressed(&mut bytes)
        .is_err()
    {
        eprintln!("Failed to serialize verifying key");
        return ExitCode::FAILURE;
    }

    if let Err(err) = fs::write(&output, &bytes) {
        eprintln!("Failed to write {}: {err}", output.display());
        return ExitCode::FAILURE;
    }

    println!(
        "Exported verifying key ({} bytes) to {}",
        bytes.len(),
        output.display()
    );
    ExitCode::SUCCESS
}

