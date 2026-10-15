"""
Access keys for Master EAs and Slave licenses.

Only the SHA-256 of a key is stored: the plain key is shown once, when it is created. Keys carry
192 random bits, so a fast hash is enough (no bcrypt). The prefix stays in clear so a manager can
tell keys apart in the dashboard and support can match a key a client reads out.
"""
import hashlib
import secrets

MASTER = "mst_"
LICENSE = "lic_"
PREFIX_LEN = 12  # "lic_" + 8 random characters


def new_key(kind: str) -> str:
    return kind + secrets.token_urlsafe(24)


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def key_prefix(key: str) -> str:
    return key[:PREFIX_LEN]
