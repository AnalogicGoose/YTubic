//! Platform-native symmetric "encrypt with current user's credentials"
//! primitive, used to protect the on-disk cookie jar (`accounts/<id>/cookies.enc`).
//!
//! - Windows: DPAPI (`CryptProtectData`/`CryptUnprotectData`) — the blob is
//!   only decryptable by the same Windows user on the same machine.
//! - Linux: the OS keyring (secret-service / kernel keyutils, via the
//!   `keyring` crate) holds a random AES-256 key; the cookie blob itself is
//!   encrypted locally with that key via AES-256-GCM. Keyrings are built for
//!   small secrets, not arbitrary-length blobs, hence the two-layer scheme.
//! - Everything else (macOS, BSD, ...): plaintext passthrough (FIXME: hook
//!   into macOS Keychain when we ship there).
//!
//! `encrypt`/`decrypt` are blocking (DPAPI, and on Linux D-Bus/keyutils
//! calls, all block) — every call site must run them via
//! `tokio::task::spawn_blocking`, never directly on an async task.

#[cfg(windows)]
// Keeps the historical "ytm-native" tag on purpose: this string is
// baked into every existing encrypted cookie jar, and changing it
// would orphan them all. It's an opaque salt, not a product name.
const ENTROPY: &[u8] = b"ytm-native/cookies.enc v1";

#[cfg(windows)]
// A fixed `ENTROPY` byte string is mixed in so a *different* app
// running as the same user can't trivially pass our blob to
// CryptUnprotectData and get our cookies out. This is a small hurdle
// against generic credential-stealer malware, not a real boundary —
// any attacker with our binary can read the entropy string.
pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let ent_blob = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptProtectData(
            &in_blob,
            ptr::null(),
            &ent_blob,
            ptr::null_mut(),
            ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptProtectData failed".into());
        }
        let data = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(data)
    }
}

#[cfg(windows)]
pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let ent_blob = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptUnprotectData(
            &in_blob,
            ptr::null_mut(),
            &ent_blob,
            ptr::null_mut(),
            ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptUnprotectData failed".into());
        }
        let data = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(data)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    //! AES-256-GCM encryption of the cookie blob, with the key held in the
    //! OS keyring via `keyring`'s `linux-native-sync-persistent` backend:
    //! reads check the kernel keyutils cache first (fast, no D-Bus round
    //! trip) and fall back to secret-service (GNOME Keyring / KWallet) on a
    //! miss, repopulating keyutils; writes go to both; the entry only
    //! persists across reboots if secret-service is reachable, so a write
    //! that can't reach it is treated as "no keyring backend available"
    //! below rather than a silently session-only key. The keyring only ever
    //! stores the 32-byte key, never the (arbitrarily large) cookie jar
    //! itself.
    //!
    //! Output format (self-describing, so `decrypt` doesn't need external
    //! state to know which path produced a given blob):
    //!   byte 0        = 0x00 -> rest of the buffer is plaintext (no usable
    //!                   keyring backend was available at encrypt time —
    //!                   headless machines, some minimal WMs, CI).
    //!   byte 0        = 0x01 -> bytes 1..13 = 12-byte AES-GCM nonce,
    //!                   bytes 13.. = ciphertext + 16-byte GCM tag.
    //!
    //! A missing keyring backend must never hard-fail login — it degrades
    //! to the plaintext tag, matching this module's behavior on every other
    //! non-Windows platform before this file existed.

    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use keyring::Entry;

    const TAG_PLAINTEXT: u8 = 0x00;
    const TAG_AES_GCM: u8 = 0x01;
    const NONCE_LEN: usize = 12;

    // Reuses the app's own bundle identifier (see tauri.conf.json) as the
    // keyring "service" name so the entry is already namespaced correctly.
    const SERVICE: &str = "com.github.ivasy.ytubic";
    const ACCOUNT: &str = "cookies-key";

    /// Fetch the persisted AES key from the OS keyring, generating and
    /// storing a fresh one on first use. Returns `Err` when no keyring
    /// backend is reachable at all (no D-Bus session, no secret-service
    /// provider, keyutils unavailable) — the caller treats that as
    /// "fall back to plaintext", not a hard failure.
    fn load_or_create_key() -> Result<Key<Aes256Gcm>, String> {
        let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring entry: {e}"))?;
        match entry.get_secret() {
            Ok(bytes) if bytes.len() == 32 => Ok(*Key::<Aes256Gcm>::from_slice(&bytes)),
            _ => {
                let key = Aes256Gcm::generate_key(&mut OsRng);
                entry
                    .set_secret(key.as_slice())
                    .map_err(|e| format!("keyring set_secret: {e}"))?;
                Ok(key)
            }
        }
    }

    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        let key = match load_or_create_key() {
            Ok(k) => k,
            Err(e) => {
                eprintln!(
                    "[secure_store] no OS keyring backend available, cookies stored in PLAINTEXT: {e}"
                );
                let mut out = Vec::with_capacity(plain.len() + 1);
                out.push(TAG_PLAINTEXT);
                out.extend_from_slice(plain);
                return Ok(out);
            }
        };
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, plain)
            .map_err(|e| format!("aes-gcm encrypt: {e}"))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        out.push(TAG_AES_GCM);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        let (&tag, rest) = encrypted
            .split_first()
            .ok_or_else(|| "empty encrypted blob".to_string())?;
        match tag {
            TAG_PLAINTEXT => Ok(rest.to_vec()),
            TAG_AES_GCM => {
                if rest.len() < NONCE_LEN {
                    return Err("encrypted blob shorter than nonce".into());
                }
                let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);
                let key = load_or_create_key()?;
                let cipher = Aes256Gcm::new(&key);
                let nonce = Nonce::from_slice(nonce_bytes);
                cipher
                    .decrypt(nonce, ciphertext)
                    .map_err(|e| format!("aes-gcm decrypt: {e}"))
            }
            other => Err(format!("unknown secure_store tag: {other}")),
        }
    }
}

#[cfg(target_os = "linux")]
pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    linux::encrypt(plain)
}

#[cfg(target_os = "linux")]
pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    linux::decrypt(encrypted)
}

#[cfg(not(any(windows, target_os = "linux")))]
// No OS-native secret store wired up on this platform yet (macOS Keychain
// support is future work — see docs/release-plan.md). Passthrough, matching
// this module's behavior before Linux got its own keyring-backed path.
pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Ok(encrypted.to_vec())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux;

    #[test]
    fn plaintext_tag_round_trips() {
        let plain = b"# Netscape HTTP Cookie File\nnot a real jar";
        let mut blob = vec![0x00u8];
        blob.extend_from_slice(plain);
        assert_eq!(linux::decrypt(&blob).unwrap(), plain);
    }

    #[test]
    #[ignore = "requires a real secret-service/keyutils backend; run manually on a Linux desktop"]
    fn aes_gcm_round_trips_through_real_keyring() {
        let plain = b"# Netscape HTTP Cookie File\nfoo\tTRUE\t/\tTRUE\t0\tSAPISID\tabc123\n";
        let encrypted = linux::encrypt(plain).expect("encrypt");
        assert_eq!(encrypted[0], 0x01, "expected the real AES-GCM path to run");
        let decrypted = linux::decrypt(&encrypted).expect("decrypt");
        assert_eq!(decrypted, plain);
    }
}
