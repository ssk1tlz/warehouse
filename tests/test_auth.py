import auth


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
