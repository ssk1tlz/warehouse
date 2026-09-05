"""Техника общего пользования: одну единицу держат несколько сотрудников."""

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


def _asset(**overrides):
    asset = {
        "id": "ast_ups",
        "name": "ЮПС APC",
        "quantity": 1,
        "status": "assigned",
        "allocations": [],
    }
    asset.update(overrides)
    return asset


def _state(assets):
    return {
        "meta": {"updatedAt": "2026-09-05T00:00:00Z"},
        "employees": [], "departments": [], "sites": [],
        "assets": assets, "movements": [], "auditLog": [], "kitTemplates": [],
    }


def test_validate_rejects_two_holders_of_one_ordinary_unit():
    state = _state([_asset(allocations=[
        {"employeeId": "emp_1", "quantity": 1},
        {"employeeId": "emp_2", "quantity": 1},
    ])])
    error = server.validate_state(state)
    assert error is not None
    assert "ЮПС APC" in error


def test_validate_allows_two_holders_of_one_shared_unit():
    state = _state([_asset(isShared=True, allocations=[
        {"employeeId": "emp_1", "quantity": 1},
        {"employeeId": "emp_2", "quantity": 1},
    ])])
    assert server.validate_state(state) is None


def test_validate_still_caps_a_single_shared_holder():
    # Общий флаг снимает ограничение на число держателей, но не на количество:
    # держать 2 шт. там, где всего 1, по-прежнему нельзя.
    state = _state([_asset(isShared=True, allocations=[
        {"employeeId": "emp_1", "quantity": 2},
    ])])
    assert server.validate_state(state) is not None


def test_validate_shared_counts_repair_against_the_stock():
    state = _state([_asset(isShared=True, repairQuantity=1, allocations=[
        {"employeeId": "emp_1", "quantity": 1},
    ])])
    assert server.validate_state(state) is not None


def test_is_shared_survives_an_import_export_round_trip(db):
    server.import_state(_state([
        _asset(isShared=True, allocations=[
            {"employeeId": "emp_1", "quantity": 1},
            {"employeeId": "emp_2", "quantity": 1},
        ]),
        _asset(id="ast_laptop", name="Ноутбук", isShared=False, status="in_stock"),
    ]), actor="tester")
    exported = {asset["id"]: asset for asset in server.export_state()["assets"]}
    assert exported["ast_ups"]["isShared"] is True
    assert exported["ast_laptop"]["isShared"] is False
    assert len(exported["ast_ups"]["allocations"]) == 2
