"""acts table: reservation ledger for act numbers not already on assignments/movements."""
import sqlite3

import server


def test_acts_table_created(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    with server.get_connection() as connection:
        row = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='acts'"
        ).fetchone()
        assert row is not None
        connection.execute(
            "INSERT INTO acts (act_number, kind, employee_id, date, created_at, created_by) "
            "VALUES (1, 'manual', NULL, '2026-09-14', '2026-09-14T00:00:00+00:00', 'alan')"
        )
        saved = connection.execute("SELECT * FROM acts WHERE act_number = 1").fetchone()
        assert saved["kind"] == "manual"
        assert saved["employee_id"] is None
