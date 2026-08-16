use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use nix::unistd::execvp;
use sha2::Sha256;
use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::path::PathBuf;
use std::process;
use zeroize::Zeroize;

const SALT: &[u8] = b"appbay-inject-v1";
const NONCE_SIZE: usize = 12;

fn derive_key(seed: &[u8], app_name: &str) -> [u8; 32] {
    let mut ikm = Vec::with_capacity(seed.len() + app_name.len());
    ikm.extend_from_slice(seed);
    ikm.extend_from_slice(app_name.as_bytes());

    let hk = Hkdf::<Sha256>::new(Some(SALT), &ikm);
    let mut key = [0u8; 32];
    hk.expand(b"secret-injection", &mut key)
        .expect("HKDF expand failed");

    ikm.zeroize();
    key
}

fn decrypt_bundle(encrypted: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if encrypted.len() < NONCE_SIZE {
        return Err("encrypted bundle too short".into());
    }

    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(key.into());

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decryption failed: {e}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Parse: appbay-inject --app <name> --service <svc> [--secrets-dir <dir>] -- <cmd...>
    let mut app_name = String::new();
    let mut service_name = String::new();
    let mut secrets_dir = String::new();
    let mut cmd_start = 0;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--app" => {
                i += 1;
                app_name = args.get(i).cloned().unwrap_or_default();
            }
            "--service" => {
                i += 1;
                service_name = args.get(i).cloned().unwrap_or_default();
            }
            "--secrets-dir" => {
                i += 1;
                secrets_dir = args.get(i).cloned().unwrap_or_default();
            }
            "--" => {
                cmd_start = i + 1;
                break;
            }
            _ => {
                eprintln!("appbay-inject: unknown flag {}", args[i]);
                process::exit(1);
            }
        }
        i += 1;
    }

    if app_name.is_empty() || cmd_start == 0 || cmd_start >= args.len() {
        eprintln!("Usage: appbay-inject --app <name> --service <svc> -- <command...>");
        process::exit(1);
    }

    if secrets_dir.is_empty() {
        secrets_dir = format!("/run/secrets/{app_name}");
    }

    let base = PathBuf::from(&secrets_dir);

    // Read seed
    let seed_hex = match fs::read_to_string(base.join("seed")) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            eprintln!("appbay-inject: failed to read seed: {e}");
            process::exit(1);
        }
    };

    let mut seed = match hex::decode(&seed_hex) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("appbay-inject: invalid seed hex: {e}");
            process::exit(1);
        }
    };

    // Derive key
    let mut key = derive_key(&seed, &app_name);
    seed.zeroize();

    // Read and decrypt bundle
    let encrypted = match fs::read(base.join("bundle.enc")) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("appbay-inject: failed to read bundle: {e}");
            process::exit(1);
        }
    };

    let mut plaintext = match decrypt_bundle(&encrypted, &key) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("appbay-inject: {e}");
            process::exit(1);
        }
    };
    key.zeroize();

    // Parse secrets JSON
    let secrets: HashMap<String, String> = match serde_json::from_slice(&plaintext) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("appbay-inject: failed to parse secrets: {e}");
            process::exit(1);
        }
    };
    plaintext.zeroize();

    // Read mapping
    let mapping_str = match fs::read_to_string(base.join("mapping.json")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("appbay-inject: failed to read mapping: {e}");
            process::exit(1);
        }
    };

    let mapping: HashMap<String, HashMap<String, String>> = match serde_json::from_str(&mapping_str)
    {
        Ok(m) => m,
        Err(e) => {
            eprintln!("appbay-inject: failed to parse mapping: {e}");
            process::exit(1);
        }
    };

    // Apply env vars for this service
    let svc_key = if service_name.is_empty() {
        app_name.clone()
    } else {
        service_name.clone()
    };

    if let Some(svc_mapping) = mapping.get(&svc_key) {
        for (vault_key, env_var_name) in svc_mapping {
            if let Some(value) = secrets.get(vault_key) {
                std::env::set_var(env_var_name, value);
            }
        }
    }

    // Also export any secrets that match directly (no mapping needed)
    for (key, value) in &secrets {
        if std::env::var(key).is_err() {
            std::env::set_var(key, value);
        }
    }

    // Exec original command
    let cmd = &args[cmd_start..];
    let c_cmd = CString::new(cmd[0].as_str()).expect("invalid command");
    let c_args: Vec<CString> = cmd
        .iter()
        .map(|a| CString::new(a.as_str()).expect("invalid arg"))
        .collect();

    // This replaces the current process — appbay-inject disappears
    match execvp(&c_cmd, &c_args) {
        Ok(_) => unreachable!(),
        Err(e) => {
            eprintln!("appbay-inject: exec failed: {e}");
            process::exit(1);
        }
    }
}
