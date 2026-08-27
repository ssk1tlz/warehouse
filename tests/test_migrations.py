import sqlite3

import pytest

import migrations


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def test_current_version_is_zero_on_fresh_connection(conn):
    assert migrations.current_version(conn) == 0


def test_pending_migrations_returns_everything_when_nothing_applied(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert [m[0] for m in migrations.pending_migrations(conn)] == [1, 2]


def test_run_migrations_applies_pending_and_records_version(conn, monkeypatch):
    calls = []
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: calls.append(c))])
    applied = migrations.run_migrations(conn)
    assert applied == [1]
    assert len(calls) == 1
    assert migrations.current_version(conn) == 1


def test_run_migrations_is_idempotent(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: None)])
    migrations.run_migrations(conn)
    assert migrations.run_migrations(conn) == []


def test_run_migrations_applies_only_versions_above_current(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None)])
    migrations.run_migrations(conn)
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert migrations.run_migrations(conn) == [2]
