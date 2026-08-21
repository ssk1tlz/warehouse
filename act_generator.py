"""Generate a filled .docx Act based on the user-provided template.

The template at ``templates/act_template.docx`` is the original Word document
the user uploaded with embedded ``{{TOKEN}}`` placeholders. We do simple
string substitution on the placeholders for top-level text, and use
ElementTree to fill the data table cells.

Supported placeholders (free to move/restyle in Word, but DON'T change their
exact spelling)::

    {{ACT_NUMBER}}      - act number (e.g. 42)
    {{EMPLOYEE_INFO}}   - "Должность, ФИО"
    {{DAY}}             - day of issue/return (DD)
    {{MONTH}}           - month name in Russian (e.g. мая)
    {{YEAR}}            - year (YYYY)
    {{ACTION_PHRASE}}   - "Работодатель передал, а Работник принял" or reverse

Adding new placeholders is just a matter of: (1) putting ``{{NAME}}`` into
the .docx in Word, and (2) registering it in :data:`PLACEHOLDERS`.
"""
from __future__ import annotations

import io
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

if getattr(sys, "frozen", False):
    # When packaged with PyInstaller, look for the template next to the .exe
    # so users can edit it without rebuilding.
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
TEMPLATE_PATH = ROOT / "templates" / "act_template.docx"

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
ET.register_namespace("w", W_NS)
ET.register_namespace("w14", W14_NS)

W = f"{{{W_NS}}}"

MONTHS_RU = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]

ISSUE_PHRASE = "Работодатель передал, а Работник принял"
RETURN_PHRASE = "Работник вернул, а Работодатель принял"


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


def _make_run(text: str, *, bold: bool = False) -> ET.Element:
    r = ET.Element(f"{W}r")
    rpr = ET.SubElement(r, f"{W}rPr")
    rfonts = ET.SubElement(rpr, f"{W}rFonts")
    rfonts.set(f"{W}ascii", "Times New Roman")
    rfonts.set(f"{W}eastAsia", "Times New Roman")
    rfonts.set(f"{W}hAnsi", "Times New Roman")
    rfonts.set(f"{W}cs", "Times New Roman")
    sz = ET.SubElement(rpr, f"{W}sz")
    sz.set(f"{W}val", "24")
    szcs = ET.SubElement(rpr, f"{W}szCs")
    szcs.set(f"{W}val", "24")
    if bold:
        ET.SubElement(rpr, f"{W}b")
        ET.SubElement(rpr, f"{W}bCs")
    t = ET.SubElement(r, f"{W}t")
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text
    return r


def _set_paragraph_text(p: ET.Element, text: str, *, bold: bool = False) -> None:
    """Replace all runs inside paragraph with a single run containing text."""
    for r in list(p.findall(f"{W}r")):
        p.remove(r)
    p.append(_make_run(text, bold=bold))


def _build_placeholders(
    *,
    act_number,
    date_iso,
    employee,
    is_issue: bool,
) -> dict[str, str]:
    """Return the {{TOKEN}} -> value mapping. Missing values fall back to
    an underscore-filled placeholder that mimics the look of a blank field."""
    parts = []
    if employee:
        for key in ("position", "fullName"):
            v = (employee.get(key) or "").strip()
            if v:
                parts.append(v)
    employee_text = ", ".join(parts)

    date_parts = parse_iso_date(date_iso) if date_iso else None
    if date_parts:
        day, month, year = date_parts
    else:
        day, month, year = "____", "____________", "____"

    return {
        "{{ACT_NUMBER}}": str(act_number).strip() if act_number else "_____",
        "{{EMPLOYEE_INFO}}": employee_text or ("_" * 52),
        "{{DAY}}": day,
        "{{MONTH}}": month,
        "{{YEAR}}": year,
        "{{ACTION_PHRASE}}": ISSUE_PHRASE if is_issue else RETURN_PHRASE,
    }


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

    # ---- 1) Plain-text placeholder substitution ----
    placeholders = _build_placeholders(
        act_number=act_number,
        date_iso=date_iso,
        employee=employee,
        is_issue=is_issue,
    )
    for token, value in placeholders.items():
        if token in document_xml:
            # Escape XML special chars in user-supplied values
            safe = (value.replace("&", "&amp;")
                          .replace("<", "&lt;")
                          .replace(">", "&gt;"))
            document_xml = document_xml.replace(token, safe)

    # ---- 2) Fill table data rows via XML manipulation ----
    root = ET.fromstring(document_xml)
    tables = list(root.iter(f"{W}tbl"))
    if tables:
        table = tables[0]
        rows = list(table.findall(f"{W}tr"))
        # Skip header row (index 0). Data rows: 1..N
        data_rows = rows[1:]
        for idx, row in enumerate(data_rows):
            if idx >= len(items):
                break
            cells = list(row.findall(f"{W}tc"))
            if len(cells) < 6:
                continue
            item = items[idx]
            qty = int(item.get("quantity") or 0)
            price = float(item.get("price") or 0)
            total = price * qty
            name = str(item.get("name") or "")
            serial = str(item.get("serialNumber") or "")
            if serial and serial != "Отсутствует":
                name_text = f"{name} (S/N: {serial})"
            else:
                name_text = name
            values = [
                name_text,
                str(item.get("inventoryNumber") or ""),
                "шт.",
                str(qty),
                f"{total:,.0f}".replace(",", " ") if total else "",
            ]
            # Fill cells 1..5 (skip cell 0 which already has the row number)
            for col_index, value in enumerate(values, start=1):
                cell = cells[col_index]
                paragraphs = cell.findall(f"{W}p")
                if paragraphs:
                    _set_paragraph_text(paragraphs[0], value)
                else:
                    new_p = ET.SubElement(cell, f"{W}p")
                    new_p.append(_make_run(value))

    # Serialize back. Build XML declaration manually so we get standalone="yes".
    body_xml = ET.tostring(root, encoding="UTF-8")
    out_xml = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body_xml

    # Build the output .docx
    out_buffer = io.BytesIO()
    with zipfile.ZipFile(out_buffer, "w", zipfile.ZIP_DEFLATED) as out_zip:
        for info in src_zip.infolist():
            if info.filename == "word/document.xml":
                out_zip.writestr(info, out_xml)
            else:
                out_zip.writestr(info, src_zip.read(info.filename))
    src_zip.close()
    return out_buffer.getvalue()


if __name__ == "__main__":
    # quick self-test
    data = generate_act(
        act_number="42",
        date_iso="2026-05-15",
        employee={"fullName": "Мардалиев Алан Муслимович", "position": "Инженер информационных технологий"},
        items=[
            {"name": "Сервер (DC, Web, RDS)", "serialNumber": "Отсутствует", "inventoryNumber": "INV-001", "quantity": 1, "price": 0},
            {"name": "Ноутбук Lenovo T14", "serialNumber": "PF1XYZ123", "inventoryNumber": "INV-002", "quantity": 1, "price": 1500000},
        ],
        is_issue=True,
    )
    out = ROOT / "_test_act.docx"
    out.write_bytes(data)
    print(f"Wrote {out} ({len(data)} bytes)")
