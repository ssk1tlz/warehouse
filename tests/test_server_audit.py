import sqlite3
from pathlib import Path

import pytest

import migrations
import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


def test_import_state_records_actor_on_new_audit_entries(db):
    payload = {
        "meta": {"updatedAt": "2026-08-27T00:00:00Z"},
        "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
        "auditLog": [{"entityType": "asset", "entityId": "ast_1", "action": "create", "changes": {}}],
        "kitTemplates": [],
    }
    server.import_state(payload, actor="bob")
    state = server.export_state()
    assert state["auditLog"][0]["actor"] == "bob"
