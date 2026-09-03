import json
import socket
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import auth
import server
import updates


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(server, "UPDATE_CACHE_PATH", tmp_path / "update_check.json")
    # GET /api/state spawns a real background update check whenever no cache
    # exists yet (should_check() with an empty cache is True) — which almost
    # every test here triggers just by calling /api/state at all. Today that
    # background thread hits the real api.github.com and gets a harmless 404
    # (no release published yet), but the moment a release exists it would
    # start writing into the REAL %ProgramData%\Warehouse\update_check.json —
    # the thread can outlive the test and resolve server.UPDATE_CACHE_PATH
    # after monkeypatch teardown has restored the real path. Neutralize the
    # actual network-issuing function itself (not just the cache) so no
    # future test can accidentally re-enable a real network call by
    # manipulating the cache directly.
    monkeypatch.setattr(updates, "check_now", lambda *args, **kwargs: None)
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


def test_static_files_are_read_from_the_resource_dir(live_server, tmp_path, monkeypatch):
    # В собранном onefile-EXE статика лежит в sys._MEIPASS, а не рядом с .exe.
    # Обслуживание должно идти из RESOURCE_DIR, иначе установленная в
    # Program Files программа отдаёт 404 на собственный index.html.
    fake_resources = tmp_path / "resources"
    fake_resources.mkdir()
    (fake_resources / "index.html").write_text("<html>из RESOURCE_DIR</html>", encoding="utf-8")
    monkeypatch.setattr(server, "RESOURCE_DIR", fake_resources)

    request = urllib.request.Request(f"{live_server}/index.html", method="GET")
    with urllib.request.urlopen(request) as response:
        body = response.read().decode("utf-8")
    assert "из RESOURCE_DIR" in body


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


def test_restore_backup_requires_admin_role(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                             json_body={"username": "sk", "password": "pass1234", "role": "storekeeper"})
    assert status == 200, body
    _, login = _request(live_server, "POST", "/api/login", json_body={"username": "sk", "password": "pass1234"})
    status, _ = _request(live_server, "POST", "/api/backups/restore", token=login["token"],
                          json_body={"filename": "x.db"})
    assert status == 403


def test_restore_backup_rejects_unlisted_filename(live_server):
    admin_token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/backups/restore", token=admin_token,
                          json_body={"filename": "../../etc/passwd"})
    assert status == 400


def test_restore_backup_rejects_corrupt_candidate_without_touching_warehouse_db(live_server):
    admin_token = _create_admin(live_server)
    # write a corrupt .db file directly into the live_server's BACKUP_DIR,
    # matching the exact filename shape list_backups() would report
    server.BACKUP_DIR.mkdir(exist_ok=True)
    corrupt_path = server.BACKUP_DIR / "warehouse_corrupt.db"
    corrupt_path.write_bytes(b"this is not a valid sqlite database file")

    original_bytes = server.DB_PATH.read_bytes()
    status, _ = _request(live_server, "POST", "/api/backups/restore", token=admin_token,
                          json_body={"filename": "warehouse_corrupt.db"})
    assert status == 400
    assert server.DB_PATH.read_bytes() == original_bytes


def test_restore_backup_round_trips_a_real_snapshot(live_server):
    admin_token = _create_admin(live_server)
    _seed_asset(server.DB_PATH)

    # snapshot the DB while the asset still has its original name
    snapshot_path = server.auto_backup()
    assert snapshot_path is not None
    snapshot_filename = Path(snapshot_path).name

    # change the asset after the snapshot was taken
    conn = sqlite3.connect(server.DB_PATH)
    conn.execute("UPDATE assets SET name = ? WHERE id = ?", ("Изменено", "ast_1"))
    conn.commit()
    conn.close()

    status, body = _request(live_server, "POST", "/api/backups/restore", token=admin_token,
                             json_body={"filename": snapshot_filename})
    assert status == 200, body

    conn = sqlite3.connect(server.DB_PATH)
    row = conn.execute("SELECT name FROM assets WHERE id = ?", ("ast_1",)).fetchone()
    conn.close()
    assert row[0] == "Ноутбук"

    pre_restore_files = list(server.BACKUP_DIR.glob("pre_restore_*.db"))
    assert len(pre_restore_files) == 1, pre_restore_files


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
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(server, "UPDATE_CACHE_PATH", tmp_path / "update_check.json")
    # Same reasoning as the live_server fixture above: some tests using this
    # fixture also hit GET /api/state, which would otherwise spawn a real
    # background thread issuing a real network call.
    monkeypatch.setattr(updates, "check_now", lambda *args, **kwargs: None)
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


def test_settings_endpoint_is_admin_only(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                            json_body={"username": "kladovshchik", "password": "parol123", "role": "storekeeper"})
    assert status == 200, body
    status, body = _request(live_server, "POST", "/api/login",
                            json_body={"username": "kladovshchik", "password": "parol123"})
    storekeeper_token = body["token"]

    status, _ = _request(live_server, "GET", "/api/settings", token=storekeeper_token)
    assert status == 403
    status, _ = _request(live_server, "POST", "/api/settings", token=storekeeper_token,
                         json_body={"checkUpdates": False})
    assert status == 403


def test_settings_default_to_update_checks_enabled(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert status == 200
    assert body["checkUpdates"] is True


def test_settings_round_trip_and_survive_in_config(live_server, monkeypatch):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                         json_body={"checkUpdates": False})
    assert status == 200
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert body["checkUpdates"] is False
    assert server.check_updates_enabled() is False


def test_saving_settings_preserves_other_config_keys(live_server):
    # config.json несёт host/port — переключение галочки не должно их потерять,
    # иначе сервер после перезапуска перестанет слушать сеть.
    server.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    server.CONFIG_PATH.write_text(json.dumps({"host": "0.0.0.0", "port": 8765}), encoding="utf-8")
    token = _create_admin(live_server)
    _request(live_server, "POST", "/api/settings", token=token, json_body={"checkUpdates": False})
    saved = json.loads(server.CONFIG_PATH.read_text(encoding="utf-8"))
    assert saved["host"] == "0.0.0.0"
    assert saved["port"] == 8765
    assert saved["checkUpdates"] is False


def test_settings_rejects_a_non_boolean_value(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                         json_body={"checkUpdates": "да"})
    assert status == 400


def test_state_reports_the_current_product_version(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200
    assert body["currentVersion"] == server.APP_VERSION


def test_post_state_success_response_includes_version_fields(live_server):
    # Regression test: POST /api/state's success response used to call
    # export_state()/import_state() directly and skip the three version
    # fields GET /api/state already carried — so hydrateState() on the
    # client resolved them to ""/null/null after every save, blanking the
    # settings modal's version label and the update banner.
    token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/state", token=token,
                             json_body=_state_payload(_asset_payload()))
    assert status == 200, body
    assert body["currentVersion"] == server.APP_VERSION
    assert "latestVersion" in body
    assert "releaseUrl" in body


def test_post_state_conflict_response_includes_version_fields(live_server, monkeypatch):
    # Same regression, for the 409 edit-conflict body.
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "1.0.0")
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    payload = _state_payload(_asset_payload())
    payload["meta"]["version"] = 999  # deliberately stale -> version mismatch -> 409
    status, body = _request(live_server, "POST", "/api/state", token=token, json_body=payload)
    assert status == 409, body
    assert body["state"]["currentVersion"] == "1.0.0"
    assert body["state"]["latestVersion"] == "1.5.0"
    assert body["state"]["releaseUrl"] == "https://example/release"


def test_state_reports_a_newer_cached_version(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "1.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] == "1.5.0"
    assert body["releaseUrl"] == "https://example/release"


def test_state_hides_a_cached_version_that_is_not_newer(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "2.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] is None


def test_state_hides_updates_when_the_check_is_switched_off(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "1.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    _request(live_server, "POST", "/api/settings", token=token, json_body={"checkUpdates": False})
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] is None


def test_state_still_works_with_no_cache_at_all(live_server):
    # Офлайн-склад: GitHub недоступен, кэша нет — /api/state обязан отвечать как обычно.
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200
    assert body["latestVersion"] is None
    assert "assets" in body


def test_background_update_check_does_not_spawn_a_thread_when_none_is_due(live_server, monkeypatch):
    # A cache written "just now" means should_check() is False — /api/state is
    # polled every 15s by the mobile app, so this is the overwhelmingly common
    # case and must not touch threading at all.
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.0.0", "https://example/release")

    def _fail_if_constructed(*args, **kwargs):
        raise AssertionError("threading.Thread must not be constructed when no check is due")

    monkeypatch.setattr(server.threading, "Thread", _fail_if_constructed)
    server.start_background_update_check()


def test_background_update_check_does_not_spawn_a_thread_when_checks_are_disabled(live_server, monkeypatch):
    token = _create_admin(live_server)
    _request(live_server, "POST", "/api/settings", token=token, json_body={"checkUpdates": False})

    def _fail_if_constructed(*args, **kwargs):
        raise AssertionError("threading.Thread must not be constructed when checkUpdates is off")

    monkeypatch.setattr(server.threading, "Thread", _fail_if_constructed)
    server.start_background_update_check()


def test_background_update_check_is_a_no_op_while_one_is_already_in_flight(live_server, monkeypatch):
    # No cache written -> should_check() is True and checkUpdates defaults to
    # on, so this reaches the lock. Simulate an in-flight check by holding a
    # lock ourselves before calling in. Swap in a fresh Lock rather than using
    # the real module-level singleton: other tests' /api/state calls spawn
    # real background threads against the real lock, and one of those could
    # still be mid-network-call (up to REQUEST_TIMEOUT_SECONDS) when this test
    # runs, making a bare acquire() on the shared lock flaky/environment-
    # dependent. A fresh Lock makes this test's precondition self-contained.
    fresh_lock = threading.Lock()
    monkeypatch.setattr(server, "_update_check_lock", fresh_lock)
    assert fresh_lock.acquire(blocking=False)
    try:
        def _fail_if_constructed(*args, **kwargs):
            raise AssertionError("should not reach thread construction — should stop at the lock")

        monkeypatch.setattr(server.threading, "Thread", _fail_if_constructed)
        server.start_background_update_check()
    finally:
        fresh_lock.release()


def test_starting_inventory_requires_admin(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                            json_body={"username": "sklad1", "password": "parol123", "role": "storekeeper"})
    assert status == 200, body
    status, body = _request(live_server, "POST", "/api/login",
                            json_body={"username": "sklad1", "password": "parol123"})
    storekeeper_token = body["token"]
    status, _ = _request(live_server, "POST", "/api/inventory/start", token=storekeeper_token)
    assert status == 403


def test_starting_inventory_creates_an_open_session(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 201, body
    assert body["sessionId"]
    assert body["startedAt"]


def test_starting_inventory_twice_returns_409_with_the_existing_session(live_server):
    token = _create_admin(live_server)
    status, first = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 201
    status, body = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 409
    assert body["session"]["id"] == first["sessionId"]


def test_starting_inventory_concurrently_only_creates_one_open_session(live_server):
    # Regression test for the check-then-insert race in handle_start_inventory:
    # without STATE_LOCK serializing the SELECT (any open session?) and the
    # INSERT, two near-simultaneous POSTs could both pass the "no open
    # session" check before either commits, leaving two open
    # inventory_sessions rows — violating this plan's Global Constraint of
    # one open inventory session server-wide. A threading.Barrier makes both
    # requests fire together deterministically rather than relying on timing
    # luck; with the lock in place this reliably produces exactly one 201 and
    # one 409 referencing the same session, every run.
    token = _create_admin(live_server)
    results = []
    barrier = threading.Barrier(2)

    def _call():
        barrier.wait()
        results.append(_request(live_server, "POST", "/api/inventory/start", token=token))

    threads = [threading.Thread(target=_call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    statuses = sorted(status for status, _ in results)
    assert statuses == [201, 409], results

    created = next(body for status, body in results if status == 201)
    conflicted = next(body for status, body in results if status == 409)
    assert conflicted["session"]["id"] == created["sessionId"]


def test_state_reports_the_active_inventory_session(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["activeInventorySession"] is None

    _request(live_server, "POST", "/api/inventory/start", token=token)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["activeInventorySession"]["startedBy"] == "admin"
