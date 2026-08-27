from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

ROLES = ("admin", "storekeeper", "viewer")


def hash_password(password: str, *, iterations: int = 390_000) -> tuple[str, str, int]:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return digest.hex(), salt, iterations


def verify_password(password: str, password_hash: str, salt: str, iterations: int) -> bool:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return hmac.compare_digest(digest.hex(), password_hash)


class AuthError(Exception):
    """User-facing auth failure: duplicate username, unknown role, etc."""


def _generate_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def has_any_user(connection) -> bool:
    return connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None


def create_user(connection, username: str, password: str, role: str) -> dict:
    if role not in ROLES:
        raise AuthError(f"Неизвестная роль: {role}")
    username = (username or "").strip()
    if not username:
        raise AuthError("Логин не может быть пустым.")
    if connection.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise AuthError(f"Пользователь «{username}» уже существует.")
    password_hash, salt, iterations = hash_password(password)
    user_id = _generate_id("usr")
    created_at = datetime.now(timezone.utc).isoformat()
    connection.execute(
        "INSERT INTO users (id, username, password_hash, salt, iterations, role, is_active, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        (user_id, username, password_hash, salt, iterations, role, created_at),
    )
    connection.commit()
    return {"id": user_id, "username": username, "role": role, "isActive": True, "createdAt": created_at}


def get_user_by_username(connection, username: str):
    return connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user_by_id(connection, user_id: str):
    return connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def list_users(connection) -> list[dict]:
    rows = connection.execute(
        "SELECT id, username, role, is_active, created_at FROM users ORDER BY username"
    ).fetchall()
    return [
        {"id": r["id"], "username": r["username"], "role": r["role"],
         "isActive": bool(r["is_active"]), "createdAt": r["created_at"]}
        for r in rows
    ]


def set_user_role(connection, user_id: str, role: str) -> None:
    if role not in ROLES:
        raise AuthError(f"Неизвестная роль: {role}")
    connection.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    connection.commit()


def set_user_active(connection, user_id: str, is_active: bool) -> None:
    connection.execute("UPDATE users SET is_active = ? WHERE id = ?", (1 if is_active else 0, user_id))
    if not is_active:
        table_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'"
        ).fetchone()
        if table_exists:
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    connection.commit()


def set_user_password(connection, user_id: str, password: str) -> None:
    password_hash, salt, iterations = hash_password(password)
    connection.execute(
        "UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?",
        (password_hash, salt, iterations, user_id),
    )
    connection.commit()


def authenticate_user(connection, username: str, password: str):
    user = get_user_by_username(connection, username)
    if user is None or not user["is_active"]:
        return None
    if not verify_password(password, user["password_hash"], user["salt"], user["iterations"]):
        return None
    return user


SESSION_LIFETIME_DAYS = 90


def create_session(connection, user_id: str, *, device_secret: str | None = None) -> dict:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=SESSION_LIFETIME_DAYS)
    connection.execute(
        "INSERT INTO sessions (token, user_id, device_secret, created_at, last_used_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (token, user_id, device_secret, now.isoformat(), now.isoformat(), expires_at.isoformat()),
    )
    connection.commit()
    return {"token": token, "expiresAt": expires_at.isoformat()}


def validate_token(connection, token: str):
    if not token:
        return None
    row = connection.execute(
        """
        SELECT sessions.token AS token, sessions.user_id AS user_id, sessions.device_secret AS device_secret,
               sessions.expires_at AS expires_at, users.username AS username, users.role AS role,
               users.is_active AS is_active
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
        """,
        (token,),
    ).fetchone()
    if row is None or not row["is_active"]:
        return None
    now = datetime.now(timezone.utc)
    if datetime.fromisoformat(row["expires_at"]) < now:
        return None
    new_expiry = now + timedelta(days=SESSION_LIFETIME_DAYS)
    connection.execute(
        "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token = ?",
        (now.isoformat(), new_expiry.isoformat(), token),
    )
    connection.commit()
    return row


def revoke_token(connection, token: str) -> None:
    connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
    connection.commit()


PAIRING_CODE_LIFETIME_MINUTES = 10


class PairingError(Exception):
    """Raised when a pairing code is invalid, expired, or already used."""


def generate_pairing_code(connection, user_id: str) -> dict:
    code = secrets.token_urlsafe(16)
    device_secret = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=PAIRING_CODE_LIFETIME_MINUTES)
    connection.execute(
        "INSERT INTO pairing_codes (code, user_id, device_secret, created_at, expires_at, used_at) "
        "VALUES (?, ?, ?, ?, ?, NULL)",
        (code, user_id, device_secret, now.isoformat(), expires_at.isoformat()),
    )
    connection.commit()
    return {"code": code, "secret": device_secret, "expiresAt": expires_at.isoformat()}


def redeem_pairing_code(connection, code: str) -> dict:
    row = connection.execute(
        "SELECT user_id, device_secret, expires_at, used_at FROM pairing_codes WHERE code = ?",
        (code,),
    ).fetchone()
    if row is None:
        raise PairingError("Код сопряжения не найден.")
    if row["used_at"] is not None:
        raise PairingError("Код сопряжения уже использован.")
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        raise PairingError("Код сопряжения истёк — сгенерируйте новый QR.")
    connection.execute(
        "UPDATE pairing_codes SET used_at = ? WHERE code = ?",
        (datetime.now(timezone.utc).isoformat(), code),
    )
    session = create_session(connection, row["user_id"], device_secret=row["device_secret"])
    user = get_user_by_id(connection, row["user_id"])
    connection.commit()
    return {"token": session["token"], "expiresAt": session["expiresAt"],
             "role": user["role"], "username": user["username"]}
