import sqlite3
from pathlib import Path

import pytest

import auth
import migrations

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    migrations.run_migrations(connection)
    yield connection
    connection.close()


def test_hash_password_returns_hash_salt_and_iterations():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert isinstance(password_hash, str) and len(password_hash) == 64  # sha256 hex digest
    assert isinstance(salt, str) and len(salt) == 32  # 16 bytes hex
    assert iterations > 0


def test_verify_password_accepts_correct_password():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert auth.verify_password("secret123", password_hash, salt, iterations) is True


def test_verify_password_rejects_wrong_password():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert auth.verify_password("wrong", password_hash, salt, iterations) is False


def test_hash_password_uses_distinct_salts():
    hash_a, salt_a, _ = auth.hash_password("secret123")
    hash_b, salt_b, _ = auth.hash_password("secret123")
    assert salt_a != salt_b
    assert hash_a != hash_b


def test_has_any_user_false_on_empty_table(conn):
    assert auth.has_any_user(conn) is False


def test_create_user_then_has_any_user_true(conn):
    auth.create_user(conn, "admin", "pass1234", "admin")
    assert auth.has_any_user(conn) is True


def test_create_user_rejects_unknown_role(conn):
    with pytest.raises(auth.AuthError):
        auth.create_user(conn, "bob", "pass1234", "superuser")


def test_create_user_rejects_duplicate_username(conn):
    auth.create_user(conn, "bob", "pass1234", "viewer")
    with pytest.raises(auth.AuthError):
        auth.create_user(conn, "bob", "other", "viewer")


def test_authenticate_user_succeeds_with_correct_password(conn):
    auth.create_user(conn, "bob", "pass1234", "storekeeper")
    user = auth.authenticate_user(conn, "bob", "pass1234")
    assert user is not None
    assert user["role"] == "storekeeper"


def test_authenticate_user_fails_with_wrong_password(conn):
    auth.create_user(conn, "bob", "pass1234", "storekeeper")
    assert auth.authenticate_user(conn, "bob", "wrong") is None


def test_authenticate_user_fails_for_deactivated_user(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    auth.set_user_active(conn, user["id"], False)
    assert auth.authenticate_user(conn, "bob", "pass1234") is None


def test_set_user_role_changes_role(conn):
    user = auth.create_user(conn, "bob", "pass1234", "viewer")
    auth.set_user_role(conn, user["id"], "admin")
    assert auth.get_user_by_id(conn, user["id"])["role"] == "admin"


def test_list_users_excludes_password_fields(conn):
    auth.create_user(conn, "bob", "pass1234", "viewer")
    users = auth.list_users(conn)
    assert users == [{"id": users[0]["id"], "username": "bob", "role": "viewer",
                       "isActive": True, "createdAt": users[0]["createdAt"]}]
