# Employee-Card Act Generation + New Template + Act-Numbering Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the equipment handover act template everywhere it's used, add a "Составить акт" button on the employee card that produces a real, permanently-numbered act from the employee's current holdings, and fix the one confirmed act-numbering bug (manual acts silently reusing numbers) without touching any existing act number.

**Architecture:** A new `acts` table becomes the reservation ledger for act numbers that don't already come from `assignments`/`movements` (manual acts and the new employee-card acts). A small `act_numbers.py` module computes "next number" across all three tables and, under the server's existing `STATE_LOCK`, atomically reserves and persists it — the same check-then-insert-under-lock pattern `handle_start_inventory` already uses. `/api/act` gains a `kind` field to trigger this reservation path when the client doesn't already have a real number, and always echoes the actual number back via an `X-Act-Number` response header (needed because the client can no longer predict manual/employee-card act numbers in advance). `act_generator.py` is repointed at the new, richer template and its table-filling logic is rewritten from ElementTree round-tripping to targeted string/regex surgery — proven necessary during this planning session (see Task 6).

**Tech Stack:** Python 3.12 stdlib (`http.server`, `sqlite3`, `zipfile`, `re`), vanilla JS (`app.js`), pytest, `node --test`.

**Spec:** [docs/superpowers/specs/2026-09-14-employee-act-template-design.md](../specs/2026-09-14-employee-act-template-design.md)

## Global Constraints

- Existing act numbers 1–133 (and their storage in `assignments`/`movements`) are never modified, migrated, or renumbered.
- "Табельный №" is never auto-filled with a fabricated or positional value — it stays blank unless a real employee ID field is added later (explicitly out of scope here).
- `templates/act_template.docx` (old template) is replaced in place; nothing in the codebase keeps referencing the old 6-column layout after this plan.
- `generate_inventory_act()` in `act_generator.py` is untouched — different, template-less document, unrelated to this work.
- New tables/columns are added only via `migrations.py` (numbered `_migrate_NNN_*` functions appended to `MIGRATIONS`), never by editing `schema.sql` — matches this repo's established convention (every prior table addition, e.g. `_migrate_026_inventory_tables`, `_migrate_035_assignments_tables`, went through a migration).
- Server-side mutation that must not race a concurrent request reuses the existing `STATE_LOCK` + `with get_connection() as connection:` check-then-insert pattern (see `handle_start_inventory`) — no new locking primitive.

---

### Task 1: Prepare and commit the new act template

**Files:**
- Create: `templates/act_template.docx` (overwrite the existing file with the new, tokenized template)
- Create (scratch, not committed): a one-off Python script to reproduce the token insertion, kept only in the task's own working notes — the important artifact is the resulting `.docx`

**Interfaces:**
- Produces: `templates/act_template.docx` containing these literal `{{TOKEN}}` strings in `word/document.xml`, each appearing exactly once:
  `{{ACT_NUMBER}}`, `{{DAY}}`, `{{MONTH}}`, `{{YEAR}}`,
  `{{PARTY_A_FULLNAME}}`, `{{PARTY_A_POSITION}}`, `{{PARTY_A_DEPARTMENT}}`, `{{PARTY_A_PHONE}}`,
  `{{PARTY_B_FULLNAME}}`, `{{PARTY_B_POSITION}}`, `{{PARTY_B_DEPARTMENT}}`, `{{PARTY_B_PHONE}}`.
  The items table (10 empty data rows, columns: №, Наименование техники, Модель/артикул, Серийный номер (S/N), Инв. №, Кол-во, Состояние, Примечание) is left as-is — Task 6 fills it by string surgery, not by template tokens.
  "Табельный № / ИНПС" lines in both party blocks are left as their original blank underscores — no token there at all.

This exact template was already prepared and verified during planning (opened cleanly in real Word via COM automation, rendered to PDF, visually confirmed correct). Reproduce it exactly:

- [ ] **Step 1: Get the source file and coalesce fragmented runs**

The user's original file is at `C:\Users\Mard\Downloads\Акт приёма-передачи техники (шаблон).docx` (or ask the user for it again if it has moved). Word sometimes splits one visible phrase across multiple `<w:r>` runs; the docx skill's `merge_runs.py` coalesces adjacent identically-formatted runs so token insertion can match whole phrases:

```bash
python "<docx-skill-dir>/scripts/merge_runs.py" "path/to/Акт приёма-передачи техники (шаблон).docx" -o merged_template.docx
```

- [ ] **Step 2: Unzip and strip any symlink entries**

```bash
mkdir unpacked
unzip -oq merged_template.docx -d unpacked
find unpacked -type l -delete
```

- [ ] **Step 3: Insert the 10 tokens by exact-offset, exact-text-match splicing**

Write and run this script (save as `apply_tokens.py` next to `unpacked/`). It is deliberately **not** a document-wide string replace — both party blocks contain byte-for-byte identical label text (e.g. `"Ф.И.О.: ______________________________________"` appears twice), so a blind replace would corrupt one block or apply the same value to both. Each edit is applied at a specific byte offset and asserts the text found there matches what's expected, failing loudly if the template has drifted:

```python
import re

xml = open("unpacked/word/document.xml", encoding="utf-8").read()
matches = list(re.finditer(r'<w:t([^>]*)>([^<]*)</w:t>', xml))
nonempty = [m for m in matches if m.group(2).strip()]

targets = {
    1: ('Акт № ____________________', 'Акт № {{ACT_NUMBER}}'),
    2: ('от «____» ______________ 20____ г.', 'от «{{DAY}}» {{MONTH}} {{YEAR}} г.'),
    8: ('Ф.И.О.: ______________________________________', 'Ф.И.О.: {{PARTY_A_FULLNAME}}'),
    9: ('Должность: __________________________________', 'Должность: {{PARTY_A_POSITION}}'),
    10: ('Подразделение / отдел: ______________________', 'Подразделение / отдел: {{PARTY_A_DEPARTMENT}}'),
    12: ('Телефон: ____________________________________', 'Телефон: {{PARTY_A_PHONE}}'),
    14: ('Ф.И.О.: ______________________________________', 'Ф.И.О.: {{PARTY_B_FULLNAME}}'),
    15: ('Должность: __________________________________', 'Должность: {{PARTY_B_POSITION}}'),
    16: ('Подразделение / отдел: ______________________', 'Подразделение / отдел: {{PARTY_B_DEPARTMENT}}'),
    18: ('Телефон: ____________________________________', 'Телефон: {{PARTY_B_PHONE}}'),
}

edits = []
for idx, (expected, replacement) in targets.items():
    m = nonempty[idx]
    actual = m.group(2)
    assert actual == expected, f"MISMATCH at index {idx}: {actual!r} != {expected!r}"
    start, end = m.span(2)
    edits.append((start, end, replacement))

edits.sort(key=lambda e: e[0], reverse=True)
for start, end, replacement in edits:
    xml = xml[:start] + replacement + xml[end:]

open("unpacked/word/document.xml", "w", encoding="utf-8").write(xml)
print(f"Applied {len(edits)} edits.")
```

Run: `python apply_tokens.py`
Expected output: `Applied 10 edits.` — if it raises `AssertionError`, the template's text differs from what was captured during planning; stop and re-derive the correct index/text pairs by dumping all non-empty `<w:t>` runs in order (`re.finditer(r'<w:t[^>]*>([^<]*)</w:t>', xml)`) and re-reading which index corresponds to which visible field.

- [ ] **Step 4: Rezip into `templates/act_template.docx`**

```python
import zipfile, os

src = zipfile.ZipFile("merged_template.docx")
out_path = "templates/act_template.docx"  # repo root
if os.path.exists(out_path):
    os.remove(out_path)
with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out_zip:
    for info in src.infolist():
        if info.filename == "word/document.xml":
            out_zip.writestr(info, open("unpacked/word/document.xml", "rb").read())
        else:
            out_zip.writestr(info, src.read(info.filename))
src.close()
```

- [ ] **Step 5: Validate structure**

```bash
python "<docx-skill-dir>/scripts/office/validate.py" templates/act_template.docx --original merged_template.docx
```
Expected: `All validations PASSED!` with a paragraph-count diff of `0`.

- [ ] **Step 6: Open in real Word and visually confirm**

```python
import win32com.client, pythoncom, os
pythoncom.CoInitialize()
word = win32com.client.DispatchEx("Word.Application")
word.Visible = False
doc = word.Documents.Open(os.path.abspath("templates/act_template.docx"), ReadOnly=True)
doc.ExportAsFixedFormat(os.path.abspath("check.pdf"), 17)
doc.Close(False)
word.Quit()
```
If this raises a COM error instead of writing `check.pdf`, the file is corrupt — do not proceed; re-check Step 3's offsets. If `pywin32` isn't installed: `pip install pywin32`. Render `check.pdf` to an image (e.g. with `pymupdf`: `pip install pymupdf`, then `fitz.open("check.pdf")[0].get_pixmap(dpi=150).save("check.png")`) and look at it — confirm: "Акт № {{ACT_NUMBER}}" and the date line show literal unfilled tokens (expected — nothing has substituted them yet), both party blocks show their tokens, the "Табельный № / ИНПС" lines are still blank underscores in both blocks, and the items table, responsibility clauses, and signature blocks are unchanged from the original.

- [ ] **Step 7: Commit**

```bash
git add templates/act_template.docx
git commit -m "feat(acts): replace act template with the new приёма-передачи form

Tokens inserted for act number, date, and both party info blocks;
item table and Табельный №/ИНПС lines left blank for Task 6/manual fill.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `acts` table migration

**Files:**
- Modify: `migrations.py`

**Interfaces:**
- Produces: table `acts(act_number INTEGER PRIMARY KEY, kind TEXT NOT NULL, employee_id TEXT, date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '')`, migration number 37.

- [ ] **Step 1: Write the failing test**

Create `tests/test_migrations_acts.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_migrations_acts.py -v`
Expected: FAIL — `sqlite3.OperationalError: no such table: acts`

- [ ] **Step 3: Add the migration**

In `migrations.py`, add this function near the other `CREATE TABLE IF NOT EXISTS` migrations (e.g. right after `_migrate_036_assignments_backfill`):

```python
def _migrate_037_acts_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS acts (
          act_number INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          employee_id TEXT,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT ''
        )
        """
    )
```

Then add it to the `MIGRATIONS` list, immediately after entry `36`:

```python
    (37, "acts table: reservation ledger for manual/employee-snapshot act numbers", _migrate_037_acts_table),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_migrations_acts.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add migrations.py tests/test_migrations_acts.py
git commit -m "feat(acts): add acts table migration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `act_numbers.py` — atomic numbering module

**Files:**
- Create: `act_numbers.py`
- Test: `tests/test_act_numbers.py`

**Interfaces:**
- Consumes: a `sqlite3.Connection` with `row_factory = sqlite3.Row` (from `server.get_connection()`), tables `acts`, `movements`, `assignments` (all with an `act_number` column).
- Produces:
  - `next_number(connection: sqlite3.Connection) -> int`
  - `reserve(connection: sqlite3.Connection, *, kind: str, employee_id: str | None, date: str, created_at: str, created_by: str) -> int` — computes `next_number()`, inserts a row into `acts`, returns the number. Caller is responsible for holding `STATE_LOCK` around this call (this module has no lock of its own, same as `assignment_codes.py`).

- [ ] **Step 1: Write the failing test**

Create `tests/test_act_numbers.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_act_numbers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'act_numbers'`

- [ ] **Step 3: Write the module**

Create `act_numbers.py`:

```python
"""Следующий свободный номер акта — сквозной по трём таблицам, где он
может жить: acts (ручные и «карточка сотрудника» акты), movements и
assignments (выдача/возврат, номер присваивается на клиенте в момент
создания операции — см. app.js getNextActNumber(), это не меняется).

Тот же приём, что assignment_codes.py для ASSIGN-NNNN: маленький модуль
без зависимости от server/migrations, вызывается из server.py.
"""
from __future__ import annotations

import sqlite3

_TABLES = ("acts", "movements", "assignments")


def next_number(connection: sqlite3.Connection) -> int:
    """Максимум act_number по всем трём таблицам, плюс один."""
    highest = 0
    for table in _TABLES:
        row = connection.execute(f"SELECT MAX(act_number) AS m FROM {table}").fetchone()
        if row["m"] is not None:
            highest = max(highest, int(row["m"]))
    return highest + 1


def reserve(
    connection: sqlite3.Connection,
    *,
    kind: str,
    employee_id: str | None,
    date: str,
    created_at: str,
    created_by: str,
) -> int:
    """Атомарно выделить и записать номер. Вызывающий код обязан
    удерживать STATE_LOCK на время вызова — этот модуль сам не
    блокирует, как и assignment_codes.next_number()."""
    number = next_number(connection)
    connection.execute(
        "INSERT INTO acts (act_number, kind, employee_id, date, created_at, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (number, kind, employee_id, date, created_at, created_by),
    )
    return number
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_act_numbers.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add act_numbers.py tests/test_act_numbers.py
git commit -m "feat(acts): add act_numbers.py for atomic act-number reservation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Expose the numbering ceiling to the client (`meta.maxActNumber`)

**Why this is needed (not optional polish):** `app.js`'s `getNextActNumber()` — used by the issue/return flow, unchanged by this plan — computes its number from the client's local `state.movements` snapshot only. Once Task 3's `acts` table starts holding real reserved numbers that never appear in `movements` or `assignments` (manual/employee-snapshot acts), a plain issue/return done right after one of those would recompute the same number `acts` just reserved — reintroducing a collision, just moved to a different pair of code paths. The fix is to tell the client the true ceiling.

**Files:**
- Modify: `server.py` (`export_state()`, `EMPTY_STATE`)
- Test: `tests/test_server_acts.py` (new file, also used by Task 5)

**Interfaces:**
- Produces: `export_state()["meta"]["maxActNumber"]` — an `int`, equal to `act_numbers.next_number(connection) - 1`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_server_acts.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_server_acts.py -v`
Expected: FAIL — `KeyError: 'maxActNumber'`

- [ ] **Step 3: Add `import act_numbers` to server.py**

In `server.py`, add the import alongside the other local-module imports (right after `import asset_codes` at line 28):

```python
import act_numbers
import asset_codes
```

- [ ] **Step 4: Compute and expose the ceiling in `export_state()`**

In `server.py`, inside `export_state()`'s `with get_connection() as connection:` block, right after the `active_inventory_session`/`attention_items` computation (just before the block ends, i.e. right before the line that currently reads `return {`), add:

```python
        max_act_number = act_numbers.next_number(connection) - 1
```

Then change the returned `"meta"` entry from:

```python
        "meta": {"updatedAt": meta_row["value"] if meta_row else None, "version": version},
```

to:

```python
        "meta": {"updatedAt": meta_row["value"] if meta_row else None, "version": version, "maxActNumber": max_act_number},
```

Also update `EMPTY_STATE` near the top of `server.py` for consistency (not required for the test to pass, but keeps the "no DB yet" shape honest):

```python
EMPTY_STATE = {
    "meta": {"updatedAt": None, "maxActNumber": 0},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_server_acts.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add server.py tests/test_server_acts.py
git commit -m "feat(acts): expose meta.maxActNumber so client numbering can't fall behind the acts table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `/api/act` — kind-based reservation + `X-Act-Number` response header

**Files:**
- Modify: `server.py` (`handle_act_request`, its call site in `do_POST`)
- Test: `tests/test_server_acts.py` (extend from Task 4)

**Interfaces:**
- Consumes: `act_numbers.reserve()` and `act_numbers.next_number()` from Task 3; `STATE_LOCK`, `get_connection()` already in `server.py`.
- Produces: `handle_act_request(self, body: bytes, username: str) -> None` (signature gains `username`). Every successful response carries header `X-Act-Number: <int>`. Request payload contract:
  - `actNumber` present and truthy → rendered as-is, no reservation (issue/return path, unchanged behavior).
  - `actNumber` absent/falsy and `kind` is `"manual"` or `"employee_snapshot"` → server reserves a number via `act_numbers.reserve()` before rendering.
  - `actNumber` absent/falsy and `kind` is anything else → `400` with a JSON `{"error": "..."}" body.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server_acts.py` (needs a way to call the handler without a real socket — build a minimal fake so the test exercises exactly the method under test):

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_acts.py -v`
Expected: FAIL — `TypeError: handle_act_request() missing 1 required positional argument: 'username'` (or similar, since the current signature only takes `body`)

- [ ] **Step 3: Update `handle_act_request` in `server.py`**

Replace the current `handle_act_request` method (currently starting `def handle_act_request(self, body: bytes) -> None:`) with:

```python
    def handle_act_request(self, body: bytes, username: str) -> None:
        if generate_act is None:
            body_out = json.dumps({"error": f"act generator not available: {_ACT_IMPORT_ERROR}"}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            body_out = json.dumps({"error": f"invalid json: {exc}"}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return

        act_number = payload.get("actNumber")
        if not act_number:
            kind = payload.get("kind")
            if kind not in ("manual", "employee_snapshot"):
                self.send_json_error(HTTPStatus.BAD_REQUEST, "actNumber or a valid kind ('manual'/'employee_snapshot') is required")
                return
            with STATE_LOCK:
                with get_connection() as connection:
                    act_number = act_numbers.reserve(
                        connection,
                        kind=kind,
                        employee_id=payload.get("employeeId") or None,
                        date=str(payload.get("date") or ""),
                        created_at=datetime.now(timezone.utc).isoformat(),
                        created_by=username,
                    )

        try:
            docx_bytes = generate_act(
                act_number=act_number,
                date_iso=payload.get("date"),
                employee=payload.get("employee"),
                items=payload.get("items") or [],
                is_issue=bool(payload.get("isIssue", True)),
            )
        except Exception as exc:  # noqa: BLE001
            body_out = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return
        filename = payload.get("filename") or f"act_{act_number}.docx"
        try:
            filename.encode("ascii")
            disp = f'attachment; filename="{filename}"'
        except UnicodeEncodeError:
            from urllib.parse import quote
            disp = f"attachment; filename*=UTF-8''{quote(filename)}"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.send_header("Content-Disposition", disp)
        self.send_header("Content-Length", str(len(docx_bytes)))
        self.send_header("X-Act-Number", str(act_number))
        self.end_headers()
        self.wfile.write(docx_bytes)
```

(Changes from the current version: new `username` parameter; the `act_number`-missing branch now requires and dispatches on `kind`, reserving atomically via `act_numbers.reserve()` under `STATE_LOCK` instead of trusting a client-supplied number; `filename` default now reads the resolved `act_number` instead of `payload.get('actNumber')`; new `X-Act-Number` response header on the success path.)

- [ ] **Step 4: Update the call site in `do_POST`**

In `server.py`, find (around line 1294-1298):

```python
        if parsed.path == "/api/act":
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            self.handle_act_request(body)
            return
```

Change the last call to:

```python
            self.handle_act_request(body, user["username"])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_acts.py -v`
Expected: PASS (6 tests total: the 2 from Task 4 plus these 4)

- [ ] **Step 6: Run the full server test suite to check for regressions**

Run: `python -m pytest -q`
Expected: all tests pass (in particular, nothing in `test_server_assignments.py` or the other `test_server_*.py` files calls `handle_act_request` today, so no other test should be affected — confirm this is still true).

- [ ] **Step 7: Commit**

```bash
git add server.py tests/test_server_acts.py
git commit -m "feat(acts): /api/act reserves numbers atomically for manual/employee-snapshot kinds

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `act_generator.py` — new template placeholders + namespace-safe table filling

**Context — read before touching this file:** The old table-filling code parses the whole `document.xml` with `ElementTree` and re-serializes it. This was tested against the new template during planning and **corrupts the file**: the new template declares roughly 20 extension namespaces (`w14`, `mc`, `wpc`, `cx`/`cx1`-`cx8`, `aink`, `am3d`, `o`, `oel`, `r`, `m`, ...); `ElementTree.tostring()` only preserves the prefix bindings you explicitly `register_namespace()` and invents `ns1`, `ns2`, ... for the rest, but the document's `mc:Ignorable` attribute still lists the *original* prefixes (`"w14 w15 w16se w16cid ..."`) — which no longer exist after serialization — and Word refuses to open the result as corrupt. The replacement below never parses the document as a tree; it finds the items table by its header text and edits only the specific cell substrings that need new content, via `re.finditer` spans and string slicing, leaving every other byte of `document.xml` untouched.

**Files:**
- Modify: `act_generator.py`
- Test: `tests/test_act_generator.py` (new file)

**Interfaces:**
- Produces: `generate_act(*, act_number=None, date_iso=None, employee=None, items=None, is_issue=True) -> bytes` — same name, drops the `action_phrase` parameter (the new template has no free-text action sentence to fill; `TypeError` if a caller still passes it, which Task 7 must not do).
- `generate_inventory_act()` is not touched.

- [ ] **Step 1: Write the failing test**

Create `tests/test_act_generator.py`:

```python
"""act_generator.generate_act() against the new template."""
import io
import zipfile

import act_generator


SAMPLE_EMPLOYEE = {
    "fullName": "Иванов Иван Иванович",
    "position": "Инженер",
    "department": "IT-отдел",
    "phone": "+998901234567",
}
SAMPLE_ITEMS = [
    {"name": "Ноутбук Lenovo T14", "serialNumber": "PF1XYZ123", "inventoryNumber": "INV-002", "quantity": 1},
    {"name": "Монитор Dell 24", "serialNumber": "Отсутствует", "inventoryNumber": "INV-045", "quantity": 2},
]


def _document_xml(docx_bytes: bytes) -> str:
    return zipfile.ZipFile(io.BytesIO(docx_bytes)).read("word/document.xml").decode("utf-8")


def test_generate_act_is_a_valid_docx_with_all_tokens_substituted():
    data = act_generator.generate_act(
        act_number=134, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=True,
    )
    zf = zipfile.ZipFile(io.BytesIO(data))
    assert zf.testzip() is None
    xml = _document_xml(data)
    assert "{{" not in xml
    assert "Акт № 134" in xml
    assert "«14» сентября 2026 г." in xml


def test_issue_fills_party_b_receiving_side_only():
    data = act_generator.generate_act(
        act_number=1, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=True,
    )
    xml = _document_xml(data)
    party_a_idx = xml.index("Передающая сторона (сдал)")
    party_b_idx = xml.index("Принимающая сторона (принял)")
    name_idx = xml.index("Иванов Иван Иванович")
    assert party_a_idx < party_b_idx < name_idx


def test_return_fills_party_a_handing_back_side_only():
    data = act_generator.generate_act(
        act_number=1, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=False,
    )
    xml = _document_xml(data)
    party_a_idx = xml.index("Передающая сторона (сдал)")
    party_b_idx = xml.index("Принимающая сторона (принял)")
    name_idx = xml.index("Иванов Иван Иванович")
    assert party_a_idx < name_idx < party_b_idx


def test_items_fill_name_serial_inventory_quantity_columns():
    data = act_generator.generate_act(
        act_number=1, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=True,
    )
    xml = _document_xml(data)
    assert "Ноутбук Lenovo T14" in xml
    assert "PF1XYZ123" in xml
    assert "INV-002" in xml
    assert "Монитор Dell 24" in xml
    assert "INV-045" in xml
    # "Отсутствует" must not leak into the S/N column verbatim
    assert "Отсутствует" not in xml


def test_missing_data_fields_stay_blank_not_fabricated():
    data = act_generator.generate_act(
        act_number=1, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=True,
    )
    xml = _document_xml(data)
    # Табельный № line is untouched blank underscores in both party blocks
    assert xml.count("Табельный № / ИНПС: ________________________") == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_act_generator.py -v`
Expected: FAIL — `FileNotFoundError` (old `TEMPLATE_PATH` still points at the pre-Task-1 file layout expectations) or token-related `AssertionError`s, since `act_generator.py` hasn't changed yet.

- [ ] **Step 3: Rewrite `act_generator.py`**

Replace the file's content from the `MONTHS_RU` constant down through the end of `generate_act()` (keep everything above `MONTHS_RU` — module docstring, imports, `TEMPLATE_PATH`, namespace setup used by `generate_inventory_act` — and keep `generate_inventory_act()` and everything after it exactly as-is):

```python
MONTHS_RU = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def parse_iso_date(value: str) -> tuple[str, str, str] | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            dt = datetime.strptime(value, fmt)
            return f"{dt.day:02d}", MONTHS_RU[dt.month - 1], str(dt.year)
        except ValueError:
            continue
    return None


def _build_placeholders(*, act_number, date_iso, employee, is_issue: bool) -> dict[str, str]:
    """{{TOKEN}} -> value. Party A is "Передающая сторона (сдал)", Party B
    is "Принимающая сторона (принял)" -- fixed physical locations in the
    template. On issue the employee is the receiving party (B); on return
    the employee is the one handing back (A). The other party has no
    reliable data source (see design spec) and stays blank."""
    date_parts = parse_iso_date(date_iso) if date_iso else None
    day, month, year = date_parts if date_parts else ("____", "____________", "____")

    employee = employee or {}
    employee_fields = {
        "fullname": employee.get("fullName") or "",
        "position": employee.get("position") or "",
        "department": employee.get("department") or "",
        "phone": employee.get("phone") or "",
    }
    empty_fields = {"fullname": "", "position": "", "department": "", "phone": ""}
    party_a = employee_fields if not is_issue else empty_fields
    party_b = employee_fields if is_issue else empty_fields

    return {
        "{{ACT_NUMBER}}": str(act_number).strip() if act_number else "_____",
        "{{DAY}}": day,
        "{{MONTH}}": month,
        "{{YEAR}}": year,
        "{{PARTY_A_FULLNAME}}": party_a["fullname"],
        "{{PARTY_A_POSITION}}": party_a["position"],
        "{{PARTY_A_DEPARTMENT}}": party_a["department"],
        "{{PARTY_A_PHONE}}": party_a["phone"],
        "{{PARTY_B_FULLNAME}}": party_b["fullname"],
        "{{PARTY_B_POSITION}}": party_b["position"],
        "{{PARTY_B_DEPARTMENT}}": party_b["department"],
        "{{PARTY_B_PHONE}}": party_b["phone"],
    }


def _xml_escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# Item table columns (0-indexed): 0=№ (already prints 1..10), 1=Наименование
# техники, 2=Модель/артикул (no data source, stays blank), 3=Серийный номер
# (S/N), 4=Инв. №, 5=Кол-во, 6=Состояние (blank), 7=Примечание (blank).
_FILL_COLUMNS = {1: "name", 3: "serialNumber", 4: "inventoryNumber", 5: "quantity"}


def _fill_paragraph(cell_xml: str, value: str) -> str:
    """Insert a run into a table cell's first paragraph. Every fillable
    cell in the new template starts as exactly one empty paragraph --
    `...</w:pPr></w:p>` with no run in between, confirmed against the
    actual template file while preparing this plan."""
    run = f'<w:r><w:t xml:space="preserve">{_xml_escape(value)}</w:t></w:r>'
    marker = "</w:pPr></w:p>"
    idx = cell_xml.find(marker)
    if idx == -1:
        idx = cell_xml.find("</w:p>")
        return cell_xml[:idx] + run + cell_xml[idx:]
    insert_at = idx + len("</w:pPr>")
    return cell_xml[:insert_at] + run + cell_xml[insert_at:]


def _fill_items_table(document_xml: str, items: list[dict]) -> str:
    """String/regex surgery on just the items table -- see the module-level
    note above generate_act() for why this can't be an ElementTree
    round-trip of the whole document."""
    header_idx = document_xml.find("Наименование техники")
    if header_idx == -1:
        return document_xml
    tbl_start = document_xml.rfind("<w:tbl>", 0, header_idx)
    tbl_end = document_xml.find("</w:tbl>", header_idx) + len("</w:tbl>")
    table_xml = document_xml[tbl_start:tbl_end]

    row_spans = [m.span() for m in re.finditer(r"<w:tr\b.*?</w:tr>", table_xml, re.DOTALL)]
    data_row_spans = row_spans[1:]  # row 0 is the header row

    edits = []
    for row_idx, (row_start, row_end) in enumerate(data_row_spans):
        if row_idx >= len(items):
            break
        item = items[row_idx]
        row_xml = table_xml[row_start:row_end]
        cell_spans = [m.span() for m in re.finditer(r"<w:tc\b.*?</w:tc>", row_xml, re.DOTALL)]
        for col_index, field in _FILL_COLUMNS.items():
            raw_value = item.get(field)
            if field == "serialNumber" and (not raw_value or raw_value == "Отсутствует"):
                raw_value = ""
            if field == "quantity":
                raw_value = str(int(raw_value or 0))
            cell_start, cell_end = cell_spans[col_index]
            new_cell_xml = _fill_paragraph(row_xml[cell_start:cell_end], str(raw_value or ""))
            edits.append((tbl_start + row_start + cell_start, tbl_start + row_start + cell_end, new_cell_xml))

    edits.sort(key=lambda e: e[0], reverse=True)
    for start, end, replacement in edits:
        document_xml = document_xml[:start] + replacement + document_xml[end:]
    return document_xml


def generate_act(
    *,
    act_number=None,
    date_iso: str | None = None,
    employee: dict | None = None,
    items: list[dict] | None = None,
    is_issue: bool = True,
) -> bytes:
    """Build a filled .docx and return its bytes."""
    if not TEMPLATE_PATH.exists():
        raise FileNotFoundError(f"Template not found at {TEMPLATE_PATH}")

    items = items or []
    template_bytes = TEMPLATE_PATH.read_bytes()

    src_zip = zipfile.ZipFile(io.BytesIO(template_bytes))
    document_xml = src_zip.read("word/document.xml").decode("utf-8")

    placeholders = _build_placeholders(
        act_number=act_number, date_iso=date_iso, employee=employee, is_issue=is_issue,
    )
    for token, value in placeholders.items():
        if token in document_xml:
            document_xml = document_xml.replace(token, _xml_escape(value))

    document_xml = _fill_items_table(document_xml, items)

    out_buffer = io.BytesIO()
    with zipfile.ZipFile(out_buffer, "w", zipfile.ZIP_DEFLATED) as out_zip:
        for info in src_zip.infolist():
            if info.filename == "word/document.xml":
                out_zip.writestr(info, document_xml)
            else:
                out_zip.writestr(info, src_zip.read(info.filename))
    src_zip.close()
    return out_buffer.getvalue()
```

Note what's gone: `ISSUE_PHRASE`, `RETURN_PHRASE`, `HANDOVER_PHRASE` constants, the `action_phrase` parameter, `_make_run`/`_set_paragraph_text` (ElementTree helpers — no longer used by `generate_act`; do **not** remove them if `generate_inventory_act()` still uses them below — check before deleting: it uses its own `_inventory_heading`/`_inventory_paragraph`/`_inventory_list_paragraphs`, which do call `_make_run`, so **keep `_make_run`**; `_set_paragraph_text` becomes unused — safe to delete it specifically).

- [ ] **Step 4: Update the module's self-test block**

Find the `if __name__ == "__main__":` block near the end of the file and replace it with:

```python
if __name__ == "__main__":
    data = generate_act(
        act_number="42",
        date_iso="2026-05-15",
        employee={
            "fullName": "Мардалиев Алан Муслимович",
            "position": "Инженер информационных технологий",
            "department": "IT-отдел",
            "phone": "+998901234567",
        },
        items=[
            {"name": "Сервер (DC, Web, RDS)", "serialNumber": "Отсутствует", "inventoryNumber": "INV-001", "quantity": 1},
            {"name": "Ноутбук Lenovo T14", "serialNumber": "PF1XYZ123", "inventoryNumber": "INV-002", "quantity": 1},
        ],
        is_issue=True,
    )
    out = ROOT / "_test_act.docx"
    out.write_bytes(data)
    print(f"Wrote {out} ({len(data)} bytes)")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_act_generator.py -v`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the module's self-test and visually confirm in real Word**

```bash
python act_generator.py
```
Then open `_test_act.docx` in Word directly (or via the COM/PDF-export approach from Task 1 Step 6) and confirm: Акт № 42, дата 15 мая 2026 г., "Принимающая сторона" block filled with Мардалиев's info (issue direction), "Передающая сторона" block blank, item table rows 1-2 filled (name/S-N or blank/inv/qty), rows 3-10 empty, everything else blank as in Task 1's check. Delete `_test_act.docx` afterward (it's a scratch file, not a repo artifact — add `_test_act.docx` to `.gitignore` if it isn't already covered by an existing ignore rule).

- [ ] **Step 7: Run the full Python test suite**

Run: `python -m pytest -q`
Expected: all pass, including `tests/test_act_generator.py` and every pre-existing test file.

- [ ] **Step 8: Commit**

```bash
git add act_generator.py tests/test_act_generator.py
git commit -m "feat(acts): rewrite act_generator.py for the new template

String/regex table-filling replaces ElementTree round-tripping, which
corrupts this template due to its extension namespaces (w14, mc, cx1-8...).
Structured PARTY_A/PARTY_B tokens replace the old single ACTION_PHRASE
sentence to match the new template's two-party layout.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `app.js` — employee-card button, manual-act fix, numbering floor

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `/api/act` response header `X-Act-Number` (Task 5); `state.meta.maxActNumber` (Task 4).
- Produces: `composeEmployeeAct(employeeId: string): Promise<void>` (new, replaces `downloadHandoverSheet`); `getNextActNumber(): number` (same name, new floor logic); `downloadActDocx(...)` gains `kind`, `employeeId`, `buildFilename` params.
- Removes: `downloadHandoverSheet`, the `HANDOVER_PHRASE`-equivalent string literal passed as `actionPhrase` (the `actionPhrase` param on `downloadActDocx`/`printManualAct`/`printAct` is dropped entirely — `act_generator.generate_act()` no longer accepts it per Task 6).

This app has no automated test harness for its UI logic (no `module.exports` from `app.js`, unlike the extracted pure modules `asset_ops.js`/`asset_codes.js` that `node --test` covers) — verify this task by running the app in a browser, per the steps at the end.

- [ ] **Step 1: Update `getNextActNumber()` to respect the server-reported ceiling**

Find (around line 4164):

```js
function getNextActNumber() {
  const maxActNumber = state.movements.reduce((max, movement) => {
    return Number(movement.actNumber || 0) > max ? Number(movement.actNumber) : max;
  }, 0);
  return maxActNumber + 1;
}
```

Replace with:

```js
function getNextActNumber() {
  const maxActNumber = state.movements.reduce((max, movement) => {
    return Number(movement.actNumber || 0) > max ? Number(movement.actNumber) : max;
  }, 0);
  const serverFloor = Number((state.meta && state.meta.maxActNumber) || 0);
  return Math.max(maxActNumber, serverFloor) + 1;
}
```

- [ ] **Step 2: Update `downloadActDocx()` to support server-assigned numbers**

Find (around line 5346):

```js
async function downloadActDocx({ actNumber, date, employee, items, isIssue, actionPhrase, filename }) {
  try {
    const payload = {
      actNumber,
      date,
      isIssue,
      employee: employee ? {
        fullName: employee.fullName || "",
        position: employee.position || "",
        department: employee.department || "",
      } : null,
      items,
      actionPhrase: actionPhrase || undefined,
      // Real acts (printAct/printManualAct) always pass a real actNumber and
      // rely on this default; downloadHandoverSheet() passes an explicit
      // filename instead, since it always has actNumber: null (a handover
      // sheet isn't a numbered act) — without an override every handover
      // sheet would download as the same indistinguishable "Акт_документ.docx".
      filename: filename || `Акт_${actNumber || "документ"}.docx`,
    };
    const response = await apiFetch("/api/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let msg = `Не удалось сформировать акт (HTTP ${response.status})`;
      try { const err = await response.json(); if (err && err.error) msg = err.error; } catch (_) {}
      showToast(msg, "error");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast("Акт скачан.", "info");
  } catch (err) {
    showToast(`Ошибка при скачивании акта: ${err.message || err}`, "error");
  }
}
```

Replace with:

```js
async function downloadActDocx({ actNumber = null, kind, employeeId = null, date, employee, items, isIssue, filename, buildFilename }) {
  try {
    const payload = {
      actNumber,
      kind,
      employeeId,
      date,
      isIssue,
      employee: employee ? {
        fullName: employee.fullName || "",
        position: employee.position || "",
        department: employee.department || "",
        phone: employee.phone || "",
      } : null,
      items,
    };
    const response = await apiFetch("/api/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let msg = `Не удалось сформировать акт (HTTP ${response.status})`;
      try { const err = await response.json(); if (err && err.error) msg = err.error; } catch (_) {}
      showToast(msg, "error");
      return;
    }
    // actNumber may not have been known before the request (manual/employee-
    // snapshot acts are numbered by the server) — the response header is the
    // one source of truth for what number actually got used.
    const realActNumber = response.headers.get("X-Act-Number") || actNumber;
    const resolvedFilename = filename || (buildFilename ? buildFilename(realActNumber) : `Акт_${realActNumber || "документ"}.docx`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resolvedFilename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast(`Акт №${realActNumber} скачан.`, "info");
  } catch (err) {
    showToast(`Ошибка при скачивании акта: ${err.message || err}`, "error");
  }
}
```

- [ ] **Step 3: Update `printAct()` and `printManualAct()`**

Find (around line 5391):

```js
function printAct(movementId) {
  const movement = state.movements.find((entry) => entry.id === movementId);
  if (!movement) return;
  const actMovements = getActMovements(movement);
  const primaryMovement = actMovements[0];
  const employee = getEmployeeById(primaryMovement.employeeId);
  const isIssue = primaryMovement.type === "issue";
  const actNumber = resolveActNumber(primaryMovement);
  downloadActDocx({
    actNumber,
    date: primaryMovement.date,
    employee,
    items: actMovements.map(buildActItemPayload),
    isIssue,
  });
}

function printManualAct({ type, employeeId, date, notes, items }) {
  const employee = getEmployeeById(employeeId);
  const isIssue = type === "issue";
  const actNumber = getNextActNumber();
  const itemsPayload = items.map((entry) => buildActItemPayload(entry));
  downloadActDocx({
    actNumber,
    date,
    employee,
    items: itemsPayload,
    isIssue,
  });
}
```

Replace with:

```js
function printAct(movementId) {
  const movement = state.movements.find((entry) => entry.id === movementId);
  if (!movement) return;
  const actMovements = getActMovements(movement);
  const primaryMovement = actMovements[0];
  const employee = getEmployeeById(primaryMovement.employeeId);
  const isIssue = primaryMovement.type === "issue";
  const actNumber = resolveActNumber(primaryMovement);
  downloadActDocx({
    actNumber,
    date: primaryMovement.date,
    employee,
    items: actMovements.map(buildActItemPayload),
    isIssue,
  });
}

// Unlike printAct (a real issue/return, numbered when the movement was
// created), a manual act has no movement of its own -- the server reserves
// a real, never-reused number for it via kind: "manual" (see act_numbers.py).
function printManualAct({ type, employeeId, date, notes, items }) {
  const employee = getEmployeeById(employeeId);
  const isIssue = type === "issue";
  const itemsPayload = items.map((entry) => buildActItemPayload(entry));
  downloadActDocx({
    kind: "manual",
    employeeId,
    date,
    employee,
    items: itemsPayload,
    isIssue,
  });
}
```

- [ ] **Step 4: Replace `downloadHandoverSheet()` with `composeEmployeeAct()`**

Find (around line 1781-1806):

```js
// "Ведомость на подпись" — a signed handover sheet: the same act_generator.py
// .docx machinery used for issue/return acts (downloadActDocx -> POST /api/act),
// but with a custom action phrase ("currently on hand as of <date>" instead of
// "issued/returned") and the item list built from the same buildHandoverRows()
// used by the employee's CSV export above, so both exports agree on contents.
async function downloadHandoverSheet(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;
  const { data } = buildHandoverRows(state, { employeeId });
  const items = data.map(([name, inventoryNumber, quantity, price]) => ({ name, inventoryNumber, quantity, price }));
  const date = new Date().toISOString().slice(0, 10);
  // actNumber is always null here (a handover sheet isn't a numbered act), so
  // downloadActDocx()'s default filename ("Акт_документ.docx") would be
  // identical for every employee/date, overwriting the previous download.
  // Same filename-sanitizing pattern as exportHandoverCsv()'s safeSuffix.
  const safeName = String(employee.fullName || employeeId).replace(/[\\/:*?"<>|]/g, "_").trim() || employeeId;
  await downloadActDocx({
    actNumber: null,
    date,
    employee,
    items,
    isIssue: true,
    actionPhrase: "За Работником числится по состоянию на",
    filename: `Обходной_лист_${safeName}_${date}.docx`,
  });
}
```

Replace with:

```js
// "Составить акт" on the employee card: unlike the old, unregistered
// "Ведомость на подпись" this replaces, it gets a real, permanent act
// number (kind: "employee_snapshot" — see act_numbers.py) and uses the
// employee's current holdings (same source as their profile's equipment
// list), not a manually picked item set.
async function composeEmployeeAct(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;
  const { holdings } = getEmployeeHoldings(employeeId);
  if (!holdings.length) {
    showToast("У сотрудника нет техники на руках.", "warning");
    return;
  }
  const items = holdings.map((holding) => ({
    name: holding.asset.name,
    serialNumber: holding.asset.serialNumber || "",
    inventoryNumber: holding.asset.inventoryNumber || "",
    quantity: Number(holding.allocation.quantity || 0),
  }));
  const date = today();
  const safeName = String(employee.fullName || employeeId).replace(/[\\/:*?"<>|]/g, "_").trim() || employeeId;
  await downloadActDocx({
    kind: "employee_snapshot",
    employeeId,
    date,
    employee,
    items,
    isIssue: true,
    buildFilename: (actNumber) => `Акт_${actNumber}_${safeName}.docx`,
  });
}
```

- [ ] **Step 5: Rewire the employee-card button**

Find (around line 2331, inside `openEmployeeDetailsModal`'s template):

```js
      <button type="button" class="secondary" onclick="downloadHandoverSheet('${employee.id}')">Ведомость на подпись</button>
```

Replace with:

```js
      <button type="button" class="secondary" onclick="composeEmployeeAct('${employee.id}')">Составить акт</button>
```

- [ ] **Step 6: Check for other references to removed names**

```bash
grep -n "downloadHandoverSheet\|actionPhrase\|HANDOVER_PHRASE" app.js index.html
```
Expected: no matches (both call sites were the ones just changed; `actionPhrase` was only ever used in the two `downloadActDocx`/`printManualAct` spots already rewritten).

- [ ] **Step 7: Manual browser verification**

Start the app the way this project normally runs it (its own dev-launch skill/script, or `python server.py` if that's the documented entry point — check for a project-specific run skill first) and in a browser:
1. Open "Сотрудники", click an employee who has equipment assigned, click "Составить акт". Confirm a `.docx` downloads named `Акт_<N>_<Имя>.docx`, and the toast says `Акт №<N> скачан.`
2. Open the downloaded file: confirm the act number, today's date, the employee's info under "Принимающая сторона (принял)", "Передающая сторона (сдал)" blank, and the item table filled with that employee's current holdings (name/S-N/inv/qty), everything else blank.
3. Click "Составить акт" again for the same employee: confirm the new download's act number is one higher than the first (proves the reservation is real and non-repeating).
4. Use "Составить акт вручную" (manual act) twice in a row for two different employees/items without reloading the page in between: confirm the two downloaded files carry two different act numbers (this is the regression test for the original bug).
5. Issue or return a real piece of equipment through the normal flow and print its act: confirm it still renders correctly with the new template and the expected act number (unaffected by any of the above).

- [ ] **Step 8: Commit**

```bash
git add app.js
git commit -m "feat(acts): employee-card 'Составить акт' button; fix manual-act number reuse

Replaces the unregistered 'Ведомость на подпись' with a real, permanently
numbered act built from the employee's current holdings. Manual acts now
get their number from the server (kind: manual) instead of computing one
client-side and never recording it, which could silently repeat.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full Python test suite**

Run: `python -m pytest -q`
Expected: all tests pass.

- [ ] **Step 2: Run the JS test suite**

Run: `node --test mobile/tests/*.test.js tests/*.test.js`
Expected: all tests pass (this plan didn't touch any of the pure modules these cover, but confirms nothing was accidentally broken).

- [ ] **Step 3: Confirm existing act numbers are untouched**

```bash
python -c "
import sqlite3
con = sqlite3.connect(r'C:\ProgramData\Warehouse\warehouse.db')
cur = con.cursor()
cur.execute('SELECT MIN(act_number), MAX(act_number), COUNT(DISTINCT act_number) FROM movements WHERE act_number IS NOT NULL')
print(cur.fetchone())
"
```
Expected: `(1, 133, 133)` — identical to the pre-implementation baseline recorded in the design spec. (This reads the live `%ProgramData%\Warehouse\warehouse.db`, not a test fixture — run it against a copy first if there's any doubt about touching production data, though nothing in this plan writes to `movements`/`assignments`.)

- [ ] **Step 4: Re-run the Task 7 manual browser checklist once more end-to-end** (issue, return, manual ×2, employee-card ×2) to confirm the full system together, not just each task in isolation.

- [ ] **Step 5: Update the design spec's status** (optional but recommended) — add a one-line note at the top of `docs/superpowers/specs/2026-09-14-employee-act-template-design.md` marking it implemented, with the date, so future readers know this isn't just a proposal.
