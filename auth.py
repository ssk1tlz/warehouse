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
