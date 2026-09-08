"""Пометка «не напоминать» у истёкшей гарантии.

Старым серверам, ИБП и мониторам гарантию уже не продлить, но дата её
окончания — настоящий факт, и стирать его ради тишины в панели «Требует
внимания» значит портить реестр. Поэтому напоминание снимается
отдельным флагом: дата остаётся на месте, запись из панели уходит.
"""

from datetime import date
from pathlib import Path

import pytest

import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


DEFAULT_SETTINGS = {"attentionWarrantyDays": 30, "attentionRepairDays": 14}


def _asset(**overrides):
    base = {
        "id": "a1", "name": "Ноутбук", "quantity": 5, "repairQuantity": 0,
        "minQuantity": 0, "warrantyEnd": "", "status": "in_stock", "repairDate": "",
        "allocations": [],
    }
    base.update(overrides)
    return base


def _payload(assets):
    return {
        "meta": {"updatedAt": "2026-09-09T00:00:00Z"},
        "employees": [], "departments": [], "sites": [], "workplaces": [],
        "assets": assets, "movements": [], "auditLog": [], "kitTemplates": [],
    }


def test_expired_warranty_with_reminder_off_is_not_flagged():
    today = date(2026, 9, 9)
    asset = _asset(warrantyEnd="2026-03-15", warrantyReminderOff=True)
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert not any(i["type"] == "warranty" for i in items)


def test_same_asset_without_the_flag_is_still_flagged():
    today = date(2026, 9, 9)
    asset = _asset(warrantyEnd="2026-03-15")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" for i in items)


def test_reminder_off_silences_only_the_warranty_item():
    # Флаг снимает напоминание о гарантии, а не о технике целиком:
    # нехватка на складе и затянувшийся ремонт обязаны остаться видны.
    today = date(2026, 9, 9)
    asset = _asset(
        warrantyEnd="2026-03-15", warrantyReminderOff=True,
        quantity=1, minQuantity=5, repairQuantity=1, repairDate="2026-01-01",
    )
    types = {i["type"] for i in server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)}
    assert types == {"low_stock", "long_repair"}


def test_flag_survives_a_state_round_trip(db):
    server.import_state(_payload([_asset(warrantyEnd="2026-03-15", warrantyReminderOff=True)]), actor="tester")
    exported = server.export_state()["assets"][0]
    assert exported["warrantyReminderOff"] is True
    assert exported["warrantyEnd"] == "2026-03-15", "дата обязана остаться в реестре"


def test_reminder_can_be_switched_back_on(db):
    # Ошибочный клик обратим: следующее сохранение с выключенным флагом
    # обязано вернуть напоминание, а не «залипнуть» на прошлом значении.
    server.import_state(_payload([_asset(warrantyEnd="2026-03-15", warrantyReminderOff=True)]), actor="tester")
    server.import_state(_payload([_asset(warrantyEnd="2026-03-15", warrantyReminderOff=False)]), actor="tester")
    assert server.export_state()["assets"][0]["warrantyReminderOff"] is False


def test_asset_saved_without_the_field_keeps_its_reminder(db):
    server.import_state(_payload([_asset(warrantyEnd="2026-03-15")]), actor="tester")
    assert server.export_state()["assets"][0]["warrantyReminderOff"] is False
