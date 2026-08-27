import json
import socket
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import auth
import server


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    server.init_db()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.WarehouseHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join()


def _request(base_url, method, path, token=None, json_body=None):
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
    req = urllib.request.Request(f"{base_url}{path}", data=data, method=method)
    if json_body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _create_admin(base_url):
    status, body = _request(base_url, "POST", "/api/setup", json_body={"username": "admin", "password": "adminpass"})
    assert status == 200, body
    return body["token"]


def test_setup_status_true_before_any_user_exists(live_server):
    status, body = _request(live_server, "GET", "/api/setup-status")
    assert status == 200
    assert body == {"needsSetup": True}


def test_setup_creates_first_admin_and_returns_token(live_server):
    token = _create_admin(live_server)
    assert token
    status, body = _request(live_server, "GET", "/api/setup-status")
    assert body == {"needsSetup": False}


def test_setup_rejects_second_call_once_a_user_exists(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/setup", json_body={"username": "x", "password": "y"})
    assert status == 409


def test_login_succeeds_with_correct_credentials(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/login", json_body={"username": "admin", "password": "adminpass"})
    assert status == 200
    assert body["role"] == "admin"


def test_login_fails_with_wrong_password(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/login", json_body={"username": "admin", "password": "wrong"})
    assert status == 401


def test_state_requires_authentication(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state")
    assert status == 401


def test_static_files_are_served_without_authentication(live_server):
    req = urllib.request.Request(f"{live_server}/index.html", method="GET")
    with urllib.request.urlopen(req) as response:
        assert response.status == 200


def _seed_asset(live_server_db_path):
    conn = sqlite3.connect(live_server_db_path)
    conn.execute(
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 5)"
    )
    conn.commit()
    conn.close()


@pytest.mark.parametrize("role,expected_status", [("admin", 200), ("storekeeper", 200), ("viewer", 403)])
def test_mobile_action_role_matrix(live_server, role, expected_status):
    # "edit" is used here (not "purchase" — mobile_actions._DISPATCH has no such
    # type; mobile can only issue/return/repair/repair_return/retire/edit an
    # EXISTING asset, never create one) and requires a pre-existing asset row.
    _seed_asset(server.DB_PATH)
    admin_token = _create_admin(live_server)
    if role == "admin":
        token = admin_token
    else:
        status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                                 json_body={"username": role, "password": "pass1234", "role": role})
        assert status == 200, body
        status, body = _request(live_server, "POST", "/api/login", json_body={"username": role, "password": "pass1234"})
        token = body["token"]
    status, body = _request(live_server, "POST", "/api/mobile/action", token=token,
                             json_body={"clientActionId": "x", "type": "edit", "assetId": "ast_1", "name": "Ноутбук новый"})
    assert status == expected_status, body


def test_viewer_can_read_state(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, body = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "GET", "/api/state", token=body["token"])
    assert status == 200


def test_users_endpoint_is_admin_only(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, body = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "GET", "/api/users", token=body["token"])
    assert status == 403


def test_logout_revokes_token(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/logout", token=token)
    assert status == 200
    status, _ = _request(live_server, "GET", "/api/state", token=token)
    assert status == 401


def test_patch_user_deactivate_then_login_fails(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    status, _ = _request(live_server, "PATCH", f"/api/users/{created['id']}", token=admin_token,
                          json_body={"isActive": False})
    assert status == 200
    status, _ = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    assert status == 401


def test_pairing_generate_requires_admin(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, viewer_login = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "POST", "/api/pair/generate", token=viewer_login["token"],
                          json_body={"userId": created["id"]})
    assert status == 403


def test_pairing_full_flow(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    status, pairing = _request(live_server, "POST", "/api/pair/generate", token=admin_token,
                                json_body={"userId": created["id"]})
    assert status == 200
    status, result = _request(live_server, "POST", "/api/pair", json_body={"code": pairing["code"]})
    assert status == 200
    assert result["username"] == "v"
    status, _ = _request(live_server, "GET", "/api/state", token=result["token"])
    assert status == 200


def test_pairing_redeem_rejects_unknown_code(live_server):
    _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/pair", json_body={"code": "bogus"})
    assert status == 400


def test_lan_info_does_not_include_a_password_field(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/lan-info", token=token)
    assert status == 200
    assert "password" not in body


def test_login_rejects_non_object_json_payload(live_server):
    _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/login", json_body=["not", "an", "object"])
    assert status == 400


def test_setup_rejects_non_object_json_payload(live_server):
    status, _ = _request(live_server, "POST", "/api/setup", json_body=5)
    assert status == 400


def test_patch_user_rejects_unknown_user_id(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "PATCH", "/api/users/no-such-user", token=admin_token,
                             json_body={"isActive": False})
    assert status == 400


def _lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


@pytest.fixture
def live_server_on_all_interfaces(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    server.init_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", 0), server.WarehouseHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port
    httpd.shutdown()
    thread.join()


def test_loopback_requests_do_not_need_a_signature(live_server):
    # live_server (from Task B6) always connects via 127.0.0.1 — this is exactly
    # the loopback path desktop traffic always takes, even in LAN mode.
    token = _create_admin(live_server)
    status, _ = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200  # no X-Signature header sent, and it still works


def _connect_via_lan_or_skip(base_url):
    # A firewall on a "Public" network profile can block a machine from
    # reaching its own LAN-facing address even when one exists — treat that
    # the same as "no LAN interface": skip rather than fail the whole suite.
    try:
        status, body = _request(base_url, "POST", "/api/setup", json_body={"username": "admin", "password": "adminpass"})
    except (OSError, urllib.error.URLError) as exc:
        pytest.skip(f"не удалось подключиться к собственному LAN-адресу: {exc}")
    assert status == 200, body
    return body["token"]


def test_non_loopback_request_without_signature_is_rejected(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    admin_token = _connect_via_lan_or_skip(base_url)
    _, login = _request(base_url, "POST", "/api/login", json_body={"username": "admin", "password": "adminpass"})
    status, _ = _request(base_url, "GET", "/api/state", token=login["token"])
    assert status == 401


def test_non_loopback_request_with_valid_signature_succeeds(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    admin_token = _connect_via_lan_or_skip(base_url)
    # Creating the viewer and generating the pairing code are ordinary desktop-admin
    # actions — the desktop app always talks over 127.0.0.1 (see warehouse_tray.py),
    # even in LAN mode, so the admin's own (unpaired, no device_secret) session is
    # not subject to the signature requirement under test here. Route those setup
    # calls over loopback on the same server/port; only the final request below
    # goes out over the real LAN address to exercise the non-loopback + signature path.
    loopback_url = f"http://127.0.0.1:{live_server_on_all_interfaces}"
    _, created = _request(loopback_url, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, pairing = _request(loopback_url, "POST", "/api/pair/generate", token=admin_token, json_body={"userId": created["id"]})
    _, paired = _request(base_url, "POST", "/api/pair", json_body={"code": pairing["code"]})
    header = auth.sign_request("GET", "/api/state", b"", pairing["secret"])
    req = urllib.request.Request(f"{base_url}/api/state", method="GET")
    req.add_header("Authorization", f"Bearer {paired['token']}")
    req.add_header("X-Signature", header)
    with urllib.request.urlopen(req) as response:
        assert response.status == 200
