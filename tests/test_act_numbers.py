"""act_numbers.py: single source of truth for 'what's the next free act number'."""
import server
import act_numbers


def _db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()


def test_next_number_starts_at_one(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    with server.get_connection() as connection:
        assert act_numbers.next_number(connection) == 1


def test_next_number_is_max_across_all_three_tables(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    with server.get_connection() as connection:
        connection.execute(
            "INSERT INTO employees (id, full_name) VALUES ('emp_1', 'Test')"
        )
        connection.execute(
            "INSERT INTO assets (id, name) VALUES ('asset_1', 'Laptop')"
        )
        connection.execute(
            "INSERT INTO movements (id, type, asset_id, employee_id, act_number, quantity, date) "
            "VALUES ('mov_1', 'issue', 'asset_1', 'emp_1', 50, 1, '2026-01-01')"
        )
        connection.execute(
            "INSERT INTO assignments (id, employee_id, status, issued_at, act_number) "
            "VALUES ('asg_1', 'emp_1', 'active', '2026-01-01', 30)"
        )
        connection.execute(
            "INSERT INTO acts (act_number, kind, employee_id, date, created_at, created_by) "
            "VALUES (10, 'manual', NULL, '2026-01-01', '2026-01-01T00:00:00+00:00', '')"
        )
        assert act_numbers.next_number(connection) == 51


def test_reserve_persists_and_two_calls_never_collide(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    with server.get_connection() as connection:
        first = act_numbers.reserve(
            connection, kind="manual", employee_id=None, date="2026-09-14",
            created_at="2026-09-14T00:00:00+00:00", created_by="alan",
        )
        second = act_numbers.reserve(
            connection, kind="manual", employee_id=None, date="2026-09-14",
            created_at="2026-09-14T00:00:01+00:00", created_by="alan",
        )
    assert first == 1
    assert second == 2
    with server.get_connection() as connection:
        rows = connection.execute("SELECT act_number, kind FROM acts ORDER BY act_number").fetchall()
    assert [r["act_number"] for r in rows] == [1, 2]
