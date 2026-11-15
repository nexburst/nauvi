#!/usr/bin/env python3
"""Verify every <file>.sig in a directory against the updater public key (#30).

    verify_sigs.py --pubkey-config desktop/tauri.conf.json --assets DIR

The .sig files are what the Tauri CLI writes: base64 of a minisign
signature. The public key is plugins.updater.pubkey in tauri.conf.json
(base64 of a minisign public key). Checks the key id, the signature of the
file (Ed25519, over its BLAKE2b-512 hash for prehashed "ED" signatures)
and the global signature over the trusted comment, as minisign -V does.
Needs the `cryptography` package.
"""

import argparse
import base64
import glob
import hashlib
import json
import os
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def decode_lines(text):
    """The non-empty lines of a base64-wrapped minisign file."""
    return [l for l in base64.b64decode(text).decode("utf-8").splitlines() if l.strip()]


def load_pubkey(config_path):
    with open(config_path, encoding="utf-8") as f:
        pubkey = json.load(f)["plugins"]["updater"]["pubkey"]
    raw = base64.b64decode(decode_lines(pubkey)[1])
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise SystemExit("error: the updater pubkey is not a minisign Ed25519 key")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:])


def verify(path, key_id, key):
    with open(path + ".sig", encoding="utf-8") as f:
        lines = decode_lines(f.read())
    sig = base64.b64decode(lines[1])
    trusted = lines[2]
    global_sig = base64.b64decode(lines[3])
    if not trusted.startswith("trusted comment: "):
        return "no trusted comment"
    alg, sig_key_id, signature = sig[:2], sig[2:10], sig[10:]
    if sig_key_id != key_id:
        return f"signed with key {sig_key_id[::-1].hex().upper()}, not {key_id[::-1].hex().upper()}"
    with open(path, "rb") as f:
        data = f.read()
    if alg == b"ED":
        data = hashlib.blake2b(data, digest_size=64).digest()
    elif alg != b"Ed":
        return f"unknown signature algorithm {alg!r}"
    try:
        key.verify(signature, data)
    except InvalidSignature:
        return "the file's signature does not verify"
    try:
        key.verify(global_sig, signature + trusted[len("trusted comment: "):].encode("utf-8"))
    except InvalidSignature:
        return "the trusted comment's signature does not verify"
    return None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pubkey-config", required=True)
    p.add_argument("--assets", required=True)
    a = p.parse_args(argv)

    key_id, key = load_pubkey(a.pubkey_config)
    print(f"updater key id {key_id[::-1].hex().upper()}")
    sigs = sorted(glob.glob(os.path.join(a.assets, "*.sig")))
    if not sigs:
        print("::error::no .sig files")
        return 1
    failed = 0
    for sig in sigs:
        problem = verify(sig[: -len(".sig")], key_id, key)
        if problem:
            print(f"::error::{os.path.basename(sig)}: {problem}")
            failed += 1
        else:
            print(f"ok: {os.path.basename(sig)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
