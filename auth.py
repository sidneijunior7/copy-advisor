from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from jose import JWTError, jwt
from passlib.context import CryptContext
import bcrypt
import os
from dotenv import load_dotenv

load_dotenv()

# Values that were once defaults or placeholders in this repository: never accept them as the signing key
_KNOWN_KEYS = {"dev_secret_key", "change-me", "secret", "changeme"}


def _load_secret_key() -> str:
    key = os.getenv("SECRET_KEY", "")
    if key in _KNOWN_KEYS or len(key) < 32:
        raise RuntimeError(
            "SECRET_KEY is missing or weak: set at least 32 random characters, "
            "e.g. python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )
    return key


# Security Config
SECRET_KEY = _load_secret_key()
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 30))
# Refreshing extends a token, but never past this long after the password was typed
SESSION_MAX_HOURS = int(os.getenv("SESSION_MAX_HOURS", 12))

# bcrypt only reads the first 72 bytes; longer passwords would be silently truncated
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_BYTES = 72

# Hashes made before bcrypt; verify_password tells the caller to rehash them on the next login.
# passlib's own bcrypt backend is broken with bcrypt>=5, so bcrypt is called directly.
_legacy_context = CryptContext(schemes=["sha256_crypt"])


def validate_password(password: str) -> Optional[str]:
    """Error message for an unacceptable new password, or None."""
    if len(password) < PASSWORD_MIN_LENGTH:
        return f"Password must have at least {PASSWORD_MIN_LENGTH} characters"
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return f"Password must have at most {PASSWORD_MAX_BYTES} bytes"
    return None


def get_password_hash(password: str) -> str:
    error = validate_password(password)
    if error:
        raise ValueError(error)
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(plain_password: str, hashed_password: Optional[str]) -> Tuple[bool, bool]:
    """(valid, needs_rehash). Unknown or disabled hashes are simply invalid."""
    if not hashed_password:
        return False, False
    try:
        if hashed_password.startswith(("$2a$", "$2b$", "$2y$")):
            secret = plain_password.encode("utf-8")
            if len(secret) > PASSWORD_MAX_BYTES:  # bcrypt>=5 raises instead of truncating
                return False, False
            return bcrypt.checkpw(secret, hashed_password.encode("ascii")), False
        if _legacy_context.identify(hashed_password):
            valid = _legacy_context.verify(plain_password, hashed_password)
            return valid, valid
    except ValueError:
        pass
    return False, False


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None, session_start: Optional[int] = None):
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    session_start = session_start or int(now.timestamp())
    session_end = datetime.fromtimestamp(session_start, timezone.utc) + timedelta(hours=SESSION_MAX_HOURS)
    to_encode.update({"exp": min(expire, session_end), "iat": int(now.timestamp()), "auth_time": session_start})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
