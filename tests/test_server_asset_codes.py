from pathlib import Path

import pytest

import asset_codes
import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


EMPTY_PAYLOAD = {
    "meta": {"updatedAt": "2026-09-06T00:00:00Z"},
    "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
    "auditLog": [], "kitTemplates": [],
}


def test_exported_state_carries_the_designation_reference(db):
    state = server.export_state()
    assert state["assetCodeTypes"] == asset_codes.reference()


def test_exported_reference_entries_have_prefix_label_and_keywords(db):
    entry = next(e for e in server.export_state()["assetCodeTypes"] if e["prefix"] == "NB")
    assert entry["label"] == "Ноутбук"
    assert "ноутбук" in entry["keywords"]


def test_import_state_ignores_a_client_supplied_reference(db):
    # Справочник — поле только на чтение, как currentVersion и attentionItems:
    # клиент не должен уметь переопределить правила, прислав своё.
    payload = dict(EMPTY_PAYLOAD)
    payload["assetCodeTypes"] = [{"prefix": "XX", "label": "Подделка", "keywords": ["всё"]}]
    server.import_state(payload, actor="tester")
    assert server.export_state()["assetCodeTypes"] == asset_codes.reference()
