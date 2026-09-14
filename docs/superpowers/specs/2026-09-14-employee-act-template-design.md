# Employee-card act generation + new template + act-numbering fix

Date: 2026-09-14

## Problem

The user provided a new, much more detailed Word template for the
"Акт приёма-передачи техники" (equipment handover act) and wants a button
on an employee's card ("Сотрудники" → click an employee) that auto-composes
this act from the equipment currently shown against that employee, filling
in only the fields the app actually has data for (item name, S/N, inventory
number, quantity, employee info, date) and leaving everything else blank
for hand-filling — plus a general request to clean up "the mess" around act
numbering.

## Investigation findings (already verified, not assumptions)

- The current act flow (`act_generator.py` + `/api/act` in `server.py`)
  already does substitution-based `.docx` generation from
  `templates/act_template.docx` using `{{TOKEN}}` placeholders for text and
  direct OOXML table manipulation for the line-items table. The new
  template will reuse this exact mechanism — we are not building a new
  generation approach, just re-pointing it at a different, richer document
  and richer token set.
- `templates/act_template.docx` (current) vs. the user's new file: the new
  one is a full replacement — two-party info blocks (Ф.И.О./должность/
  отдел/табельный/телефон for both "сдал" and "принял"), an 8-column item
  table (№, наименование, модель/артикул, S/N, инв.№, кол-во, состояние,
  примечание), responsibility clauses, and a signature block. It ships with
  no `{{TOKENS}}` yet.
- **Act numbering is not actually broken where it looks broken.** Querying
  the live DB (`%ProgramData%\Warehouse\warehouse.db`) directly:
  - `movements`: 137 issue + 5 return rows all have `act_number` set (142
    total, matches exactly) — no legacy fallback rows exist today.
  - Numbers in use span 1–133 contiguous, no gaps.
  - The three cases that share an `act_number` across multiple rows (e.g.
    #10 ×5, #3 ×4, #4 ×3) all belong to the same employee + same date +
    same type — i.e. legitimate multi-item acts, not collisions.
  - `assignments`: 128/137 have `act_number`; the 9 without are pure
    workplace-transfer/personal-assignment bookkeeping rows
    ("Перенесено на рабочее место" / "Закреплено лично") that were never
    meant to have a physical act — also correct, not a bug.
  - The one genuine bug: **"Составить акт вручную"**
    (`handleManualActSubmit` → `printManualAct` in `app.js`) calls
    `getNextActNumber()` (client-side `MAX(movement.actNumber) + 1`) purely
    to print a document — it never records that number anywhere. Two
    manual acts printed back-to-back (or one manual act followed by a real
    issue before the manual one is otherwise persisted) can silently get
    the same number. This is the actual source of "the mess."
  - `employees.customId`, which `formatEmployeeId()` reads for a stable
    "Табельный №", **does not exist anywhere** — no DB column, no form
    field, nothing ever sets it. `formatEmployeeId()` always falls through
    to a positional index (`ID: 0007`) instead, which the code's own
    comment already flags as unstable (shifts when employees are
    added/removed/filtered). So today there is no real data source for
    "Табельный №" — see decision below.
- `assets` table has no "модель/артикул" field, so that template column has
  no data source and stays blank.
- `users` table has only `username` + `role`, no `fullName`/`position` — so
  the counter-party ("сдал" when issuing) has no reliable data source
  either and stays blank.
- Server already has the right primitives to fix the numbering bug
  correctly instead of papering over it:
  - `ThreadingHTTPServer` (concurrent request threads) + a single global
    `STATE_LOCK = threading.Lock()` already used for exactly this
    "check-then-insert must not race" shape (see
    `handle_start_inventory`, `/api/state` import, `handle_restore_backup`
    in `server.py`).
  - `assignment_codes.py` already implements the same kind of
    "scan table for MAX, return +1" numbering as a small standalone module
    with no dependency on `server`/`migrations` — the new act-numbering
    fix follows this exact shape.
  - `migrations.py` uses small numbered `_migrate_NNN_description(c)`
    functions appended to a `MIGRATIONS` list, `CREATE TABLE IF NOT EXISTS`
    for new tables — the new `acts` table follows this pattern.

## Decisions (confirmed with the user)

1. The employee-card button produces a **real, registered, numbered act**
   (not an unregistered snapshot) — it permanently reserves a number that
   can never be reused.
2. The new template **replaces the old one everywhere** it's used: issue,
   return, and the employee-card button. The old `templates/act_template.docx`
   stops being referenced (kept in the repo, unused, unless the user later
   asks to delete it).
3. Numbering fix: **no renumbering/reset**. Existing 1–133 stay exactly as
   they are. Only the manual-act bug gets fixed so a duplicate can never
   happen again, for any future act (manual, issue, return, or the new
   employee-card one).
4. **Табельный №**: never fabricate a number. Since there's no real data
   source for it today (see above), the field simply stays blank on every
   generated act — no code is added to fall back to the unstable positional
   index. If the user later wants this populated, that's a separate,
   explicit ask (adding a real employee-ID field to the data model and
   form) — out of scope here.

## Design

### 1. New `acts` table — single source of truth for "is this number taken"

```sql
CREATE TABLE IF NOT EXISTS acts (
  act_number INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'manual' | 'employee_snapshot'
  employee_id TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
)
```

Added as the next `_migrate_0NN_acts_table` entry in `migrations.py`,
following the existing `CREATE TABLE IF NOT EXISTS` + append-to-`MIGRATIONS`
pattern (see `_migrate_026_inventory_tables`, `_migrate_029_workplaces_table`
for the closest precedents).

This table only exists to **reserve numbers for acts that don't already get
one from `assignments`/`movements`** (i.e. manual acts and the new
employee-snapshot act). Issue/return acts are unaffected — they already
persist their `act_number` on the `assignments`/`movements` row at the
moment the transaction is created, and that continues exactly as today.

### 2. Centralized, atomic numbering — `act_numbers.py`

New small standalone module, same shape as `assignment_codes.py` (no
dependency on `server`/`migrations`, callable from both):

```python
def next_number(connection: sqlite3.Connection) -> int:
    """MAX across every place an act_number can live, plus one."""
    highest = 0
    for table, column in (("acts", "act_number"), ("movements", "act_number"), ("assignments", "act_number")):
        row = connection.execute(f"SELECT MAX({column}) AS m FROM {table}").fetchone()
        if row["m"] is not None:
            highest = max(highest, int(row["m"]))
    return highest + 1
```

Server-side callers reserve a number like this (mirrors
`handle_start_inventory`'s existing check-then-insert pattern exactly):

```python
with STATE_LOCK:
    with get_connection() as connection:
        number = act_numbers.next_number(connection)
        connection.execute(
            "INSERT INTO acts (act_number, kind, employee_id, date, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
            (number, kind, employee_id, date, now_iso(), username),
        )
        connection.commit()
```

This is the actual fix: the reservation and the insert happen inside the
same lock + same transaction, so two concurrent requests can never compute
the same "next" number — unlike today's `printManualAct()`, which computes
a number on the client from a stale in-memory `state.movements` snapshot
and never writes it anywhere.

### 3. `/api/act` request handling — two act "kinds"

`handle_act_request` in `server.py` currently just takes whatever
`actNumber` the client sends and renders it. It's extended to distinguish:

- **Pre-numbered acts** (issue/return): client already has a real
  `actNumber` from the `assignments`/`movements` row created earlier in the
  same operation. Behavior unchanged — render as given.
- **Acts needing a fresh number** (`kind: "manual"` or
  `kind: "employee_snapshot"`, no `actNumber` in the payload): server
  reserves the next number via `act_numbers.next_number` + inserts into
  `acts` (the atomic block above) *before* calling `generate_act`, then
  renders with that number.

This moves number assignment for these two cases from client to server,
which is what makes the atomicity possible.

### 4. Template placeholders (`templates/act_template.docx` → replaced by
the new file, tokens inserted into its `word/document.xml`)

Per the docx-editing skill: unzip → edit `word/document.xml` in place
(never regenerate from scratch) → rezip → validate.

Auto-filled (data exists and is reliable):

| Placeholder | Source |
|---|---|
| `{{ACT_NUMBER}}` | reserved/real act number |
| `{{DAY}}` / `{{MONTH}}` / `{{YEAR}}` | act date |
| Item table columns: Наименование техники, Серийный номер (S/N), Инв. №, Кол-во | one row per item, same `buildActItemPayload`-style mapping already used today |

Token substitution is fixed-position (find/replace on static XML text), so
a single `{{EMPLOYEE_...}}` token cannot "move" between the two party
blocks depending on direction. Instead both physical blocks get their own
token set, and the generator decides at runtime which one is real and
which stays empty:

| Placeholder (in "Передающая сторона / сдал" block) | Placeholder (in "Принимающая сторона / принял" block) |
|---|---|
| `{{PARTY_A_FULLNAME}}` | `{{PARTY_B_FULLNAME}}` |
| `{{PARTY_A_POSITION}}` | `{{PARTY_B_POSITION}}` |
| `{{PARTY_A_DEPARTMENT}}` | `{{PARTY_B_DEPARTMENT}}` |
| `{{PARTY_A_PHONE}}` | `{{PARTY_B_PHONE}}` |

- Issue (or employee-card snapshot, which is issue-direction): `PARTY_B_*`
  = employee's `fullName`/`position`/`department`/`phone`; `PARTY_A_*`
  = `""` (blank — no reliable issuing-side person data, see `users`
  finding above).
- Return: `PARTY_A_*` = employee data (employee is the one handing back);
  `PARTY_B_*` = `""`.
- Substituting a token with `""` removes just that text, leaving the
  surrounding label ("Ф.И.О.: ") with nothing after it — same visual
  result as a blank template field, still hand-writable.

Left blank (template's original underscore lines stay untouched — no
token placed there at all, so nothing needs "un-filling" when data is
missing):

- Модель/артикул, Состояние, Примечание (no data source)
- Табельный № / ИНПС (see Decision 4 — always blank)
- The counterparty block for whichever side isn't the employee (no
  reliable staff name/position data — see `users` table finding)
- "Итого... прописью", комплектация, срок использования, город

### 5. `act_generator.py` changes

- `TEMPLATE_PATH` now points at the new file.
- `_build_placeholders()` gains the `PARTY_A_*`/`PARTY_B_*` token set above,
  populated based on `is_issue` as described in section 4, and drops the old
  single-string `{{EMPLOYEE_INFO}}`/`{{ACTION_PHRASE}}` approach — the new
  template has structured per-party fields rather than one free-text
  sentence, so structured tokens map directly instead of re-deriving a
  "Должность, ФИО" string.
- Table-filling logic (`ET.iter` over `w:tbl`) updates column count/order
  from 6 to the new template's 8, filling only columns 1 (наименование),
  3 (S/N), 4 (инв.№), 5 (кол-во) — columns 2 (модель), 6 (состояние), 7
  (примечание) stay untouched.
- `generate_inventory_act()` is untouched — unrelated feature, different
  template-less document.

### 6. Employee-card button (`app.js`)

`downloadHandoverSheet(employeeId)` is replaced by a new
`composeEmployeeAct(employeeId)`:

- Same source data as today: `getEmployeeHoldings(employeeId)` → items via
  `buildActItemPayload`-equivalent mapping.
- Date = today (act print date), not each item's original issue date —
  confirmed acceptable since items can have different original issue dates.
- POST to `/api/act` with `kind: "employee_snapshot"`, `employeeId`, no
  `actNumber` — server reserves one per the atomic flow above.
- Button in `openEmployeeDetailsModal()` (the "Ведомость на подпись" button,
  `app.js` employee profile actions) relabeled/rewired to call this instead
  — replacing it outright per the confirmed decision, not adding a third
  button.
- `exportEmployeeHandoverCsv` (separate CSV export) is untouched — different
  feature, not part of this request.

### 7. Issue/return flow

No behavioral change beyond rendering through the new template — they
already create their `assignments`/`movements` row with a real
`act_number` before calling `/api/act`, which continues to work as a
"pre-numbered" render per section 3.

## Testing

- `tests/test_server_assignments.py` / new test file for `act_numbers.py`:
  unit-test `next_number()` against a fixture DB with rows in `acts`,
  `movements`, `assignments` to confirm it takes the true max across all
  three.
- Server-level test: two rapid `kind: "manual"` (or `employee_snapshot`)
  requests must yield two different `act_number`s (regression test for the
  bug being fixed) — spin up real threads hitting `handle_act_request`
  concurrently, or unit-test the lock/reserve function directly if spinning
  up the full HTTP server in tests is impractical.
- Manual verification: generate one issue act, one return act, one
  employee-card act, and one manual act; open each `.docx` (via
  `soffice.py --convert-to pdf` + `pdftoppm`, per the docx skill) and
  visually confirm the right fields are filled and everything else is
  blank as designed.
- Confirm existing acts (1–133) are untouched — no migration touches
  existing `act_number` values anywhere.
