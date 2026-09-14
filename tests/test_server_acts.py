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


class _FakeRequest:
    """Just enough of BaseHTTPRequestHandler's surface for handle_act_request:
    it only calls self.send_response/send_header/end_headers/wfile.write and
    (via generate_act) never touches anything else on self."""

    def __init__(self):
        self.status = None
        self.headers_sent = {}
        self.body = b""

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers_sent[key] = value

    def end_headers(self):
        pass


class _FakeWfile:
    def __init__(self):
        self.data = b""

    def write(self, chunk):
        self.data += chunk


def _call_handle_act_request(body: dict, username: str = "alan"):
    import json as json_module
    handler = server.WarehouseHandler.__new__(server.WarehouseHandler)
    fake = _FakeRequest()
    handler.send_response = fake.send_response
    handler.send_header = fake.send_header
    handler.end_headers = fake.end_headers
    handler.wfile = _FakeWfile()
    handler.handle_act_request(json_module.dumps(body).encode("utf-8"), username)
    return fake, handler.wfile


def test_manual_kind_reserves_a_real_number(db):
    fake, wfile = _call_handle_act_request({
        "kind": "manual",
        "employeeId": "emp_1",
        "date": "2026-09-14",
        "employee": {"fullName": "Иванов Иван", "position": "Инженер", "department": "IT", "phone": ""},
        "items": [],
        "isIssue": True,
    })
    assert fake.status == 200
    assert fake.headers_sent["X-Act-Number"] == "1"
    with server.get_connection() as connection:
        row = connection.execute("SELECT kind, employee_id FROM acts WHERE act_number = 1").fetchone()
    assert row["kind"] == "manual"
    assert row["employee_id"] == "emp_1"


def test_two_manual_acts_never_collide(db):
    for _ in range(2):
        fake, _ = _call_handle_act_request({
            "kind": "manual", "employeeId": None, "date": "2026-09-14",
            "employee": None, "items": [], "isIssue": True,
        })
    with server.get_connection() as connection:
        numbers = [r["act_number"] for r in connection.execute("SELECT act_number FROM acts").fetchall()]
    assert sorted(numbers) == [1, 2]


def test_missing_kind_without_act_number_is_rejected(db):
    fake, _ = _call_handle_act_request({"date": "2026-09-14", "items": []})
    assert fake.status == 400


def test_pre_numbered_act_is_not_reserved_again(db):
    fake, _ = _call_handle_act_request({
        "actNumber": 77, "date": "2026-09-14", "employee": None, "items": [], "isIssue": True,
    })
    assert fake.status == 200
    assert fake.headers_sent["X-Act-Number"] == "77"
    with server.get_connection() as connection:
        row = connection.execute("SELECT * FROM acts WHERE act_number = 77").fetchone()
    assert row is None  # pre-numbered acts don't get an acts-table row
