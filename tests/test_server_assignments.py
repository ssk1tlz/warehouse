"""Слой выдач на сервере: экспорт, импорт, нумерация, валидация."""

import pytest

import server


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


BASE_PAYLOAD = {
    "meta": {"updatedAt": "2026-09-10T00:00:00Z"},
    "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
    "auditLog": [], "kitTemplates": [], "workplaces": [],
}


def payload(**overrides):
    data = {key: list(value) if isinstance(value, list) else value for key, value in BASE_PAYLOAD.items()}
    data.update(overrides)
    return data


def assignment(**overrides):
    data = {
        "id": "asg_1",
        "employeeId": "emp_1",
        "workplaceId": "",
        "department": "",
        "site": "",
        "status": "active",
        "issuedAt": "2026-09-10",
        "returnedAt": None,
        "actNumber": 1,
        "notes": "",
        "items": [{"id": "asgi_1", "assetId": "a1", "quantity": 1,
                   "returnedQuantity": 0, "scope": "personal", "returnedAt": None}],
    }
    data.update(overrides)
    return data


def asset(**overrides):
    data = {"id": "a1", "name": "Ноутбук", "quantity": 1, "allocations": []}
    data.update(overrides)
    return data


# ─── Экспорт и обратный ход ────────────────────────────────────────

def test_empty_state_has_assignments_list(db):
    assert server.export_state()["assignments"] == []


def test_assignment_round_trip(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")

    saved = server.export_state()["assignments"]
    assert len(saved) == 1
    assert saved[0]["code"] == "ASSIGN-0001"
    assert saved[0]["employeeId"] == "emp_1"
    assert saved[0]["status"] == "active"
    assert saved[0]["items"] == [{
        "id": "asgi_1", "assetId": "a1", "quantity": 1,
        "returnedQuantity": 0, "scope": "personal", "returnedAt": None,
    }]


def test_assignment_carries_employee_and_workplace_together(db):
    # Главное отличие от asset_allocations: у выдачи получатель может
    # быть составным — человек и стол, за которым он сидит.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        workplaces=[{"id": "wp_1", "name": "Стол №7", "department": "Бухгалтерия"}],
        assets=[asset()],
        assignments=[assignment(workplaceId="wp_1")],
    ), actor="tester")

    saved = server.export_state()["assignments"][0]
    assert (saved["employeeId"], saved["workplaceId"]) == ("emp_1", "wp_1")


# ─── Нумерация ASSIGN-NNNN принадлежит серверу ─────────────────────

def test_code_is_assigned_by_the_server(db):
    # Клиент не присылает код вовсе — как с WP-NNNN у рабочих мест.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")
    assert server.export_state()["assignments"][0]["code"] == "ASSIGN-0001"


def test_client_cannot_overwrite_an_assigned_code(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment(code="ASSIGN-9999")],
    ), actor="tester")
    assert server.export_state()["assignments"][0]["code"] == "ASSIGN-0001"


def test_numbering_continues_across_separate_saves(db):
    # Та же ловушка, что ловил тест нумерации рабочих мест: следующий
    # номер считается до перезаписи таблицы, иначе каждая новая выдача
    # снова получала бы ASSIGN-0001.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(), asset(id="a2", name="Монитор")],
        assignments=[
            assignment(),
            assignment(id="asg_2", actNumber=2,
                       items=[{"id": "asgi_2", "assetId": "a2", "quantity": 1,
                               "returnedQuantity": 0, "scope": "personal", "returnedAt": None}]),
        ],
    ), actor="tester")

    codes = {row["id"]: row["code"] for row in server.export_state()["assignments"]}
    assert codes == {"asg_1": "ASSIGN-0001", "asg_2": "ASSIGN-0002"}


# ─── Проекция в asset_allocations ──────────────────────────────────

def test_allocations_are_derived_from_assignments(db):
    # Клиент не прислал ни одной выдачи в asset.allocations — они
    # обязаны появиться сами, из выдачи.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")

    allocations = server.export_state()["assets"][0]["allocations"]
    assert allocations == [{"employeeId": "emp_1", "department": "", "site": "",
                            "workplaceId": "", "quantity": 1}]


def test_workplace_scope_projects_onto_the_desk_not_the_person(db):
    # Столовая позиция числится за местом: при смене сотрудника она
    # остаётся там же. Личная — за человеком.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        workplaces=[{"id": "wp_1", "name": "Стол №7", "department": "Бухгалтерия"}],
        assets=[asset(id="a1", name="Монитор")],
        assignments=[assignment(workplaceId="wp_1", items=[
            {"id": "asgi_1", "assetId": "a1", "quantity": 1,
             "returnedQuantity": 0, "scope": "workplace", "returnedAt": None},
        ])],
    ), actor="tester")

    allocations = server.export_state()["assets"][0]["allocations"]
    assert allocations == [{"employeeId": None, "department": "", "site": "",
                            "workplaceId": "wp_1", "quantity": 1}]


def test_returned_items_disappear_from_allocations(db):
    # §20 ТЗ: после возврата техника пропадает у сотрудника и снова
    # свободна на складе, но выдача остаётся в истории.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment(status="returned", returnedAt="2026-09-11", items=[
            {"id": "asgi_1", "assetId": "a1", "quantity": 1, "returnedQuantity": 1,
             "scope": "personal", "returnedAt": "2026-09-11"},
        ])],
    ), actor="tester")

    state = server.export_state()
    assert state["assets"][0]["allocations"] == []
    assert len(state["assignments"]) == 1


def test_partially_returned_item_keeps_the_remainder_allocated(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(id="a1", name="Мышь", quantity=5)],
        assignments=[assignment(items=[
            {"id": "asgi_1", "assetId": "a1", "quantity": 5, "returnedQuantity": 2,
             "scope": "personal", "returnedAt": None},
        ])],
    ), actor="tester")

    assert server.export_state()["assets"][0]["allocations"][0]["quantity"] == 3


def test_state_without_assignments_key_keeps_the_old_allocations(db):
    # Обратная совместимость: мобильный клиент и старая версия десктопа
    # ничего не знают о выдачах и присылают только allocations. Стереть
    # их значило бы обнулить всю выданную технику при первом же
    # сохранении со старого клиента.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(allocations=[{"employeeId": "emp_1", "department": "", "site": "",
                                    "workplaceId": "", "quantity": 1}])],
    ), actor="tester")

    assert server.export_state()["assets"][0]["allocations"][0]["employeeId"] == "emp_1"


# ─── Валидация ─────────────────────────────────────────────────────

def test_rejects_an_assignment_without_a_recipient(db):
    error = server.validate_state(payload(
        assets=[asset()],
        assignments=[assignment(employeeId=None)],
    ))
    assert error and "получател" in error.lower()


def test_rejects_returning_more_than_was_issued(db):
    error = server.validate_state(payload(
        assets=[asset()],
        assignments=[assignment(items=[
            {"id": "asgi_1", "assetId": "a1", "quantity": 1, "returnedQuantity": 3,
             "scope": "personal", "returnedAt": None},
        ])],
    ))
    assert error and "возвращено" in error.lower()


def test_rejects_issuing_the_same_unit_twice(db):
    # §7 и §17 ТЗ: одну единицу нельзя держать выданной двум сразу.
    error = server.validate_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов"}, {"id": "emp_2", "fullName": "Петров"}],
        assets=[asset()],
        assignments=[
            assignment(),
            assignment(id="asg_2", employeeId="emp_2", actNumber=2, items=[
                {"id": "asgi_2", "assetId": "a1", "quantity": 1, "returnedQuantity": 0,
                 "scope": "personal", "returnedAt": None},
            ]),
        ],
    ))
    assert error and "Ноутбук" in error


def test_allows_reissuing_a_unit_that_came_back(db):
    # Та же техника, тот же склад — но первая выдача закрыта, так что
    # вторая законна (§14 ТЗ).
    error = server.validate_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов"}, {"id": "emp_2", "fullName": "Петров"}],
        assets=[asset()],
        assignments=[
            assignment(status="returned", items=[
                {"id": "asgi_1", "assetId": "a1", "quantity": 1, "returnedQuantity": 1,
                 "scope": "personal", "returnedAt": "2026-09-11"},
            ]),
            assignment(id="asg_2", employeeId="emp_2", actNumber=2, items=[
                {"id": "asgi_2", "assetId": "a1", "quantity": 1, "returnedQuantity": 0,
                 "scope": "personal", "returnedAt": None},
            ]),
        ],
    ))
    assert error is None


def test_rejects_a_workplace_scoped_item_without_a_workplace(db):
    error = server.validate_state(payload(
        assets=[asset()],
        assignments=[assignment(items=[
            {"id": "asgi_1", "assetId": "a1", "quantity": 1, "returnedQuantity": 0,
             "scope": "workplace", "returnedAt": None},
        ])],
    ))
    assert error and "рабоч" in error.lower()


def test_rejects_an_item_pointing_at_unknown_equipment(db):
    error = server.validate_state(payload(
        assets=[asset()],
        assignments=[assignment(items=[
            {"id": "asgi_1", "assetId": "ghost", "quantity": 1, "returnedQuantity": 0,
             "scope": "personal", "returnedAt": None},
        ])],
    ))
    assert error and "ghost" in error


# ─── Сохранение без ключа assignments: вкладка до обновления ───────
# Мобильный клиент POST /api/state не шлёт вовсе, так что без ключа
# assignments приходит только вкладка браузера, открытая до обновления
# программы. Её allocations могут расходиться с выдачами — и сохранить
# их как есть значило бы рассинхронизировать базу. Поэтому выдачи
# сверяются с присланным состоянием по правилу «состояние главнее».

def test_state_without_assignments_closes_what_the_old_tab_returned(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
    ), actor="tester")
    # Старая вкладка вернула ноутбук и шлёт allocations без выдач.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(allocations=[])],
    ), actor="old-tab")

    state = server.export_state()
    assert state["assets"][0]["allocations"] == []
    assert state["assignments"][0]["status"] == "returned"

    # И следующее полное сохранение ничего не воскрешает.
    server.import_state(state, actor="tester")
    assert server.export_state()["assets"][0]["allocations"] == []


def test_state_without_assignments_recovers_what_the_old_tab_issued(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(allocations=[{"employeeId": "emp_1", "department": "", "site": "",
                                    "workplaceId": "", "quantity": 1}])],
    ), actor="old-tab")

    state = server.export_state()
    assert len(state["assignments"]) == 1
    assert state["assignments"][0]["employeeId"] == "emp_1"

    server.import_state(state, actor="tester")
    assert server.export_state()["assets"][0]["allocations"][0]["employeeId"] == "emp_1"


# ─── Связь «движение → выдача» переживает сохранение ───────────────

def test_movement_keeps_its_assignment_across_a_desktop_save(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
        movements=[{"id": "mov_1", "type": "issue", "assetId": "a1", "employeeId": "emp_1",
                    "quantity": 1, "date": "2026-09-10", "assignmentId": "asg_1"}],
    ), actor="tester")

    assert server.export_state()["movements"][0]["assignmentId"] == "asg_1"


def test_old_tab_save_keeps_the_links_it_does_not_know_about(db):
    # Вкладка до обновления не знает поля assignmentId. Если бы импорт
    # писал только присланное, связь, проставленная миграцией 036,
    # стиралась бы первым же её сохранением.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset()],
        assignments=[assignment()],
        movements=[{"id": "mov_1", "type": "issue", "assetId": "a1", "employeeId": "emp_1",
                    "quantity": 1, "date": "2026-09-10", "assignmentId": "asg_1"}],
    ), actor="tester")
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Иванов Иван"}],
        assets=[asset(allocations=[{"employeeId": "emp_1", "department": "", "site": "",
                                    "workplaceId": "", "quantity": 1}])],
        movements=[{"id": "mov_1", "type": "issue", "assetId": "a1", "employeeId": "emp_1",
                    "quantity": 1, "date": "2026-09-10"}],
    ), actor="old-tab")

    assert server.export_state()["movements"][0]["assignmentId"] == "asg_1"


def test_transfer_movement_type_is_accepted(db):
    # Перенос между «лично» и «на место» пишется одним движением
    # «Перемещение», а не парой возврат + выдача: техника никому не
    # передавалась из рук в руки, акт на неё не печатается, и график
    # выдач/возвратов не должен насчитать мнимых операций.
    error = server.validate_state(payload(
        assets=[asset()],
        movements=[{"id": "mov_1", "type": "transfer", "assetId": "a1", "quantity": 1, "date": "2026-09-11"}],
    ))
    assert error is None
