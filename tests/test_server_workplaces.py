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
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия",
                      "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}],
    ), actor="tester")
    saved = server.export_state()["workplaces"]
    assert saved == [{
        "id": "w1", "name": "Стол 2", "code": "WP-0001", "department": "Бухгалтерия",
        "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна",
    }]


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


def test_workplace_gets_assigned_code_on_creation(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["code"] == "WP-0001"


def test_workplace_code_is_preserved_across_edits(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"}],
    ), actor="tester")
    first_code = server.export_state()["workplaces"][0]["code"]
    # Клиент никогда не должен уметь переписать код, даже если пришлёт своё значение.
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2 (у окна)", "department": "Бухгалтерия", "code": "WP-9999"}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["code"] == first_code


def test_second_new_workplace_in_same_save_gets_next_code(db):
    server.import_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 1", "department": "Бухгалтерия"},
            {"id": "w2", "name": "Стол 2", "department": "Бухгалтерия"},
        ],
    ), actor="tester")
    codes = {w["id"]: w["code"] for w in server.export_state()["workplaces"]}
    assert codes == {"w1": "WP-0001", "w2": "WP-0002"}


def test_new_workplace_in_a_later_save_continues_the_numbering(db):
    # Нумерация считается по таблице ДО `DELETE FROM workplaces` в
    # import_state. Если этот SELECT когда-нибудь переедет после удаления,
    # счётчик молча начнёт заново с WP-0001 при каждом сохранении.
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 1", "department": "Бухгалтерия"}],
    ), actor="tester")
    server.import_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 1", "department": "Бухгалтерия"},
            {"id": "w2", "name": "Стол 2", "department": "Бухгалтерия"},
        ],
    ), actor="tester")
    codes = {w["id"]: w["code"] for w in server.export_state()["workplaces"]}
    assert codes == {"w1": "WP-0001", "w2": "WP-0002"}


def test_validate_state_requires_department():
    error = server.validate_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": ""}],
    ))
    assert error == "Укажите отдел для рабочего места «Стол 2»."


def test_validate_state_rejects_duplicate_name_in_same_department():
    error = server.validate_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"},
            {"id": "w2", "name": "стол 2", "department": "Бухгалтерия"},
        ],
    ))
    assert error == "Рабочее место с таким названием уже существует в этом отделе."


def test_validate_state_allows_same_name_in_different_departments():
    error = server.validate_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"},
            {"id": "w2", "name": "Стол 2", "department": "IT"},
        ],
    ))
    assert error is None
