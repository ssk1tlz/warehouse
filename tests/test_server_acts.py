"""/api/act: kind-based number reservation, and the meta.maxActNumber ceiling."""
import pytest

import server


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


def test_max_act_number_is_zero_on_empty_db(db):
    assert server.export_state()["meta"]["maxActNumber"] == 0


def test_max_act_number_reflects_acts_table(db):
    with server.get_connection() as connection:
        import act_numbers
        act_numbers.reserve(
            connection, kind="manual", employee_id=None, date="2026-09-14",
            created_at="2026-09-14T00:00:00+00:00", created_by="alan",
        )
    assert server.export_state()["meta"]["maxActNumber"] == 1
