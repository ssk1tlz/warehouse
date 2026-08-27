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


def _raw_status(base_url, path):
    """Status code only — for endpoints whose error body is HTML, not JSON."""
    req = urllib.request.Request(f"{base_url}{path}", method="GET")
    try:
        with urllib.request.urlopen(req) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


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
    for path in ("/", "/index.html", "/app.js", "/styles.css"):
        req = urllib.request.Request(f"{live_server}{path}", method="GET")
        with urllib.request.urlopen(req) as response:
            assert response.status == 200, path


@pytest.mark.parametrize(
    "path",
    [
        "/warehouse.db",          # the entire database
        "/server.py",             # server source
        "/auth.py",               # password hashing / token logic
        "/config.json",           # LAN configuration
        "/backups/anything.db",   # everything under backups/
        "/schema.sql",
    ],
)
def test_non_allowlisted_static_paths_are_not_served(live_server, path):
    # Static files are public by necessity (the client shell loads before login),
    # so only an explicit allowlist keeps the database off the LAN. Anything else
    # must 404 — including files that really do exist next to the server.
    assert _raw_status(live_server, path) == 404, f"{path} must not be downloadable"


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
                             json_body={"clientActionId": "x", "type": "edit", "assetId": "ast_1",
                                        "baseRev": 0, "name": "Ноутбук новый"})
    assert status == expected_status, body


def test_mobile_edit_conflict_returns_409_with_current_asset(live_server):
    _seed_asset(server.DB_PATH)
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/mobile/action", token=admin_token,
                             json_body={"clientActionId": "edit-1", "type": "edit", "assetId": "ast_1",
                                        "baseRev": 0, "name": "A"})
    assert status == 200, body
    # Second edit still claims baseRev=0, but the first edit above already
    # bumped the asset's rev to 1 — this must be rejected as a conflict.
    status, body = _request(live_server, "POST", "/api/mobile/action", token=admin_token,
                             json_body={"clientActionId": "edit-2", "type": "edit", "assetId": "ast_1",
                                        "baseRev": 0, "name": "B"})
    assert status == 409, body
    assert body["currentAsset"]["rev"] == 1
    assert body["currentAsset"]["name"] == "A"


def test_get_state_includes_asset_rev(live_server):
    _seed_asset(server.DB_PATH)
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0


def _asset_payload(**overrides):
    payload = {
        "id": "ast_1",
        "name": "Ноутбук",
        "category": "Техника",
        "inventoryNumber": "INV-1",
        "serialNumber": "SN-1",
        "location": "Офис",
        "purchaseDate": "2024-01-01",
        "warrantyEnd": "2025-01-01",
        "quantity": 5,
    }
    payload.update(overrides)
    return payload


def _state_payload(asset):
    return {
        "meta": {"updatedAt": "2026-08-27T00:00:00Z"},
        "employees": [],
        "departments": [],
        "sites": [],
        "assets": [asset],
        "movements": [],
        "auditLog": [],
        "kitTemplates": [],
    }


def test_import_state_preserves_rev_when_editable_fields_unchanged(live_server):
    token = _create_admin(live_server)
    asset = _asset_payload()
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(asset))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0
    # Re-POST the identical asset (as the desktop does on every debounced save).
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(asset))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0


def test_import_state_bumps_rev_when_name_changes(live_server):
    token = _create_admin(live_server)
    asset = _asset_payload()
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(asset))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0
    changed = _asset_payload(name="Ноутбук новый")
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(changed))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 1


def test_import_state_does_not_bump_rev_when_only_quantity_changes(live_server):
    token = _create_admin(live_server)
    asset = _asset_payload()
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(asset))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0
    changed = _asset_payload(quantity=10)
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=_state_payload(changed))
    assert status == 200, body
    assert body["assets"][0]["rev"] == 0
    assert body["assets"][0]["quantity"] == 10


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


def _admin_id(base_url, token):
    _, body = _request(base_url, "GET", "/api/users", token=token)
    return next(u["id"] for u in body["users"] if u["username"] == "admin")


def test_cannot_deactivate_the_only_admin(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "PATCH", f"/api/users/{_admin_id(live_server, token)}",
                             token=token, json_body={"isActive": False})
    assert status == 400, body
    assert "администратор" in body["error"].lower()
    # And the account still works.
    status, _ = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200


@pytest.mark.parametrize("role", ["storekeeper", "viewer"])
def test_cannot_demote_the_only_admin(live_server, role):
    token = _create_admin(live_server)
    status, body = _request(live_server, "PATCH", f"/api/users/{_admin_id(live_server, token)}",
                             token=token, json_body={"role": role})
    assert status == 400, body
    status, users = _request(live_server, "GET", "/api/users", token=token)
    assert next(u for u in users["users"] if u["username"] == "admin")["role"] == "admin"


def test_cannot_demote_and_deactivate_the_only_admin_in_one_request(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "PATCH", f"/api/users/{_admin_id(live_server, token)}",
                          token=token, json_body={"role": "viewer", "isActive": False})
    assert status == 400


def test_demoting_an_admin_is_allowed_when_a_second_active_admin_exists(live_server):
    token = _create_admin(live_server)
    status, second = _request(live_server, "POST", "/api/users", token=token,
                               json_body={"username": "admin2", "password": "pass1234", "role": "admin"})
    assert status == 200, second
    # Demote the second admin — the first one is still there.
    status, _ = _request(live_server, "PATCH", f"/api/users/{second['id']}", token=token,
                          json_body={"role": "viewer"})
    assert status == 200
    # Now the original really is the last one, so it is protected again.
    status, _ = _request(live_server, "PATCH", f"/api/users/{_admin_id(live_server, token)}",
                          token=token, json_body={"role": "viewer"})
    assert status == 400


def test_deactivating_an_admin_is_allowed_when_a_second_active_admin_exists(live_server):
    token = _create_admin(live_server)
    _, second = _request(live_server, "POST", "/api/users", token=token,
                          json_body={"username": "admin2", "password": "pass1234", "role": "admin"})
    status, _ = _request(live_server, "PATCH", f"/api/users/{second['id']}", token=token,
                          json_body={"isActive": False})
    assert status == 200


def test_changing_only_the_password_of_the_last_admin_still_works(live_server):
    # The guard must not block an unrelated field.
    token = _create_admin(live_server)
    status, _ = _request(live_server, "PATCH", f"/api/users/{_admin_id(live_server, token)}",
                          token=token, json_body={"password": "newpass123"})
    assert status == 200
    status, _ = _request(live_server, "POST", "/api/login",
                          json_body={"username": "admin", "password": "newpass123"})
    assert status == 200


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


def test_get_backups_requires_admin_role(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, body = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "GET", "/api/backups", token=body["token"])
    assert status == 403


def test_get_backups_returns_list_for_admin(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/backups", token=admin_token)
    assert status == 200, body
    assert "backups" in body


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


def test_oversized_content_length_is_rejected_before_authentication(live_server):
    # An unauthenticated caller must not be able to make the server allocate an
    # arbitrary buffer just by announcing a huge Content-Length. No token is
    # sent here on purpose: the size check has to run before authenticate().
    req = urllib.request.Request(f"{live_server}/api/state", data=b"{}", method="POST")
    req.add_header("Content-Type", "application/json")
    # urllib sets Content-Length from the data; override it with the lie.
    req.add_header("Content-Length", str(server.MAX_BODY_BYTES + 1))
    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
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


def _connect_via_lan_or_skip(base_url, loopback_url):
    # A firewall on a "Public" network profile can block a machine from
    # reaching its own LAN-facing address even when one exists — treat that
    # the same as "no LAN interface": skip rather than fail the whole suite.
    try:
        _request(base_url, "GET", "/api/setup-status")
    except (OSError, urllib.error.URLError) as exc:
        pytest.skip(f"не удалось подключиться к собственному LAN-адресу: {exc}")
    # /api/setup is loopback-only (bootstrapping the first admin is a
    # local-console action), so create the admin the way the desktop does.
    status, body = _request(loopback_url, "POST", "/api/setup",
                            json_body={"username": "admin", "password": "adminpass"})
    assert status == 200, body
    return body["token"]


def test_setup_is_refused_from_a_non_loopback_address(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    try:
        status, _ = _request(base_url, "GET", "/api/setup-status")
    except (OSError, urllib.error.URLError) as exc:
        pytest.skip(f"не удалось подключиться к собственному LAN-адресу: {exc}")
    status, body = _request(base_url, "POST", "/api/setup",
                            json_body={"username": "attacker", "password": "pass1234"})
    assert status == 403, body
    # Nothing was created, so the local console can still bootstrap.
    loopback_url = f"http://127.0.0.1:{live_server_on_all_interfaces}"
    status, _ = _request(loopback_url, "GET", "/api/setup-status")
    assert status == 200
    status, body = _request(loopback_url, "POST", "/api/setup",
                            json_body={"username": "admin", "password": "adminpass"})
    assert status == 200, body


def test_non_loopback_request_without_signature_is_rejected(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    loopback_url = f"http://127.0.0.1:{live_server_on_all_interfaces}"
    _connect_via_lan_or_skip(base_url, loopback_url)
    _, login = _request(base_url, "POST", "/api/login", json_body={"username": "admin", "password": "adminpass"})
    status, _ = _request(base_url, "GET", "/api/state", token=login["token"])
    assert status == 401


def test_non_loopback_request_with_valid_signature_succeeds(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    # Creating the admin/viewer and generating the pairing code are ordinary
    # desktop-admin actions — the desktop app always talks over 127.0.0.1 (see
    # warehouse_tray.py), even in LAN mode, so the admin's own (unpaired, no
    # device_secret) session is not subject to the signature requirement under
    # test here. Route those setup calls over loopback on the same server/port;
    # only the final request below goes out over the real LAN address to
    # exercise the non-loopback + signature path.
    loopback_url = f"http://127.0.0.1:{live_server_on_all_interfaces}"
    admin_token = _connect_via_lan_or_skip(base_url, loopback_url)
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
