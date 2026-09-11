"""Сверка двух реализаций проекции выдач: server.py и asset_ops.js.

Проекция описана дважды, и иначе быть не может: клиент пересчитывает её
сразу после операции, чтобы экран не ждал сохранения, а сервер — при
импорте, потому что состояние приходит целиком и присланной копии
доверять нельзя. Разойдись правила — карточка сотрудника показывала бы
одно, база хранила бы другое, и заметить это удалось бы только после
перезагрузки страницы.

Тест гоняет обе реализации по одному набору выдач и требует совпадения
до единой записи.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import server

ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node не установлен — сверка с asset_ops.js пропущена",
)


def make(assignment_id, items, **recipient):
    data = {
        "id": assignment_id,
        "employeeId": None,
        "workplaceId": "",
        "department": "",
        "site": "",
        "status": "active",
        "issuedAt": "2026-09-10",
        "items": items,
    }
    data.update(recipient)
    return data


def item(asset_id, quantity=1, returned=0, scope="personal"):
    return {
        "id": f"i_{asset_id}_{quantity}_{returned}_{scope}",
        "assetId": asset_id,
        "quantity": quantity,
        "returnedQuantity": returned,
        "scope": scope,
    }


# Наборы, на которых реализации легче всего разойтись: составной
# получатель, смешанные scope, частичные и полные возвраты, слияние
# нескольких выдач в одну запись, выдача только на стол.
CASES = [
    [],
    [make("a1", [item("nb")], employeeId="emp_1")],
    [make("a1", [item("mon", scope="workplace")], employeeId="emp_1", workplaceId="wp_7")],
    [make("a1", [item("nb"), item("mon", scope="workplace")], employeeId="emp_1", workplaceId="wp_7")],
    [make("a1", [item("nb", quantity=5, returned=2)], employeeId="emp_1")],
    [make("a1", [item("nb", quantity=1, returned=1)], employeeId="emp_1")],
    [make("a1", [item("nb")], employeeId="emp_1"), make("a2", [item("nb", quantity=2)], employeeId="emp_1")],
    [make("a1", [item("nb")], employeeId="emp_1"), make("a2", [item("nb")], department="Бухгалтерия")],
    [make("a1", [item("mon", scope="workplace")], workplaceId="wp_7")],
    [make("a1", [item("nb")], site="АБЗ")],
    # Личная позиция у выдачи, где человека нет вовсе: получатель
    # обязан свалиться на стол одинаково в обеих реализациях.
    [make("a1", [item("nb")], workplaceId="wp_7")],
    # Ноль и отрицательный остаток не должны попадать в проекцию.
    [make("a1", [item("nb", quantity=2, returned=2)], employeeId="emp_1")],
    [
        make("a1", [item("nb"), item("kb")], employeeId="emp_1", workplaceId="wp_7"),
        make("a2", [item("mon", scope="workplace")], employeeId="emp_1", workplaceId="wp_7"),
        make("a3", [item("nb", quantity=3, returned=1)], employeeId="emp_2"),
    ],
]


def normalize(projection):
    """Порядок записей внутри техники не важен — важен состав."""
    return {
        asset_id: sorted(
            (
                (
                    entry.get("employeeId"), entry.get("department"),
                    entry.get("site"), entry.get("workplaceId"), entry.get("quantity"),
                )
                for entry in entries
            ),
            # По строковому виду: получатель-сотрудник хранится как None,
            # а остальные как пустая строка, и обычное сравнение кортежей
            # на такой паре падает.
            key=str,
        )
        for asset_id, entries in projection.items()
    }


def project_in_node(assignments):
    script = (
        "const ops = require(process.argv[1]);"
        "const input = JSON.parse(process.argv[2]);"
        "process.stdout.write(JSON.stringify(ops.projectAllocations(input)));"
    )
    result = subprocess.run(
        ["node", "-e", script, str(ROOT / "asset_ops.js"), json.dumps(assignments, ensure_ascii=False)],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("assignments", CASES, ids=range(len(CASES)))
def test_projection_matches_between_python_and_javascript(assignments):
    assert normalize(server.project_allocations(assignments)) == normalize(project_in_node(assignments))
