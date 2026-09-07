from pathlib import Path

import pytest

import server


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


BASE_PAYLOAD = {
    "meta": {"updatedAt": "2026-09-07T00:00:00Z"},
    "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
    "auditLog": [], "kitTemplates": [], "workplaces": [],
}


def payload(**overrides):
    data = {key: list(value) if isinstance(value, list) else value for key, value in BASE_PAYLOAD.items()}
    data.update(overrides)
    return data


def test_empty_state_has_workplaces_list(db):
    assert server.export_state()["workplaces"] == []


def test_workplace_round_trip(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}],
    ), actor="tester")
    saved = server.export_state()["workplaces"]
    assert saved == [{"id": "w1", "name": "Стол 2", "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}]


def test_workplace_without_occupant_is_allowed(db):
    # Свободный стол — нормальное состояние, а не ошибка.
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 3", "employeeId": None, "site": "", "notes": ""}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["employeeId"] is None


def test_allocation_carries_workplace_id(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2"}],
        assets=[{
            "id": "a1", "name": "Монитор", "quantity": 1,
            "allocations": [{"employeeId": None, "department": "", "site": "", "workplaceId": "w1", "quantity": 1}],
        }],
    ), actor="tester")
    allocation = server.export_state()["assets"][0]["allocations"][0]
    assert allocation["workplaceId"] == "w1"
    assert allocation["employeeId"] is None


def test_employee_allocation_has_empty_workplace_id(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        assets=[{
            "id": "a1", "name": "Ноутбук", "quantity": 1,
            "allocations": [{"employeeId": "emp_1", "department": "", "site": "", "quantity": 1}],
        }],
    ), actor="tester")
    allocation = server.export_state()["assets"][0]["allocations"][0]
    assert (allocation["employeeId"], allocation["workplaceId"]) == ("emp_1", "")


def test_deleting_employee_keeps_the_workplace(db):
    # Стол переживает своего хозяина: техника на нём остаётся.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": "emp_1"}],
    ), actor="tester")
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": None}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["name"] == "Стол 2"


def test_movement_carries_workplace_id(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2"}],
        assets=[{"id": "a1", "name": "Монитор", "quantity": 1, "allocations": []}],
        movements=[{"id": "m1", "type": "issue", "assetId": "a1", "workplaceId": "w1",
                    "quantity": 1, "date": "2026-09-07"}],
    ), actor="tester")
    assert server.export_state()["movements"][0]["workplaceId"] == "w1"
