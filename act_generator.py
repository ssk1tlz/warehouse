"""Generate a filled .docx Act based on the user-provided template.

The template at ``templates/act_template.docx`` is the original Word document
the user uploaded with embedded ``{{TOKEN}}`` placeholders. We do simple
string substitution on the placeholders for top-level text, and string/regex
surgery (never a full ElementTree parse/re-serialize) to fill the items
table's data cells.

Why not ElementTree for the table too, like before: this template declares
roughly 20 extension namespaces (``w14``, ``mc``, ``wpc``, ``cx``/``cx1``-
``cx8``, ``aink``, ``am3d``, ``o``, ``oel``, ``r``, ``m``, ...).
``ElementTree.tostring()`` only preserves the prefix bindings you explicitly
``register_namespace()`` and invents ``ns1``, ``ns2``, ... for the rest, but
the document's ``mc:Ignorable`` attribute still lists the *original* prefixes
(``"w14 w15 w16se w16cid ..."``) — which no longer exist after serialization
— and Word refuses to open the result as corrupt. So table-filling below
never parses the document as a tree; it finds the items table by its header
text and edits only the specific cell substrings that need new content, via
``re.finditer`` spans and string slicing, leaving every other byte of
``document.xml`` untouched.

Supported placeholders (free to move/restyle in Word, but DON'T change their
exact spelling)::

    {{ACT_NUMBER}}          - act number (e.g. 42)
    {{DAY}}                 - day of issue/return (DD)
    {{MONTH}}               - month name in Russian (e.g. мая)
    {{YEAR}}                - year (YYYY)
    {{PARTY_A_FULLNAME}}    - "Передающая сторона (сдал)" full name
    {{PARTY_A_POSITION}}    - Party A position
    {{PARTY_A_DEPARTMENT}}  - Party A department
    {{PARTY_A_PHONE}}       - Party A phone
    {{PARTY_B_FULLNAME}}    - "Принимающая сторона (принял)" full name
    {{PARTY_B_POSITION}}    - Party B position
    {{PARTY_B_DEPARTMENT}}  - Party B department
    {{PARTY_B_PHONE}}       - Party B phone

On issue the employee is the receiving party (B); on return the employee is
the one handing back (A). The other party has no reliable data source and
stays blank.

Adding new placeholders is just a matter of: (1) putting ``{{NAME}}`` into
the .docx in Word, and (2) registering it in :func:`_build_placeholders`.
"""
from __future__ import annotations

import io
import re
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

# Постоянный представитель работодателя — тот, кто физически выдаёт и
# принимает технику. В системе нет данных о том, кто сидит за клавиатурой
# (в users только username/role, без ФИО/должности), поэтому это захардкожено
# по прямому запросу, а не выведено из данных.
COMPANY_REPRESENTATIVE = {
    "fullname": "Мардалиев Алан Муслимович",
    "position": "Инженер информационных технологий",
    "department": "IT",
    "phone": "",
}


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


def _build_placeholders(*, act_number, date_iso, employee, is_issue: bool) -> dict[str, str]:
    """{{TOKEN}} -> value. Party A is "Передающая сторона (сдал)", Party B
    is "Принимающая сторона (принял)" -- fixed physical locations in the
    template. On issue the employee is the receiving party (B) and
    COMPANY_REPRESENTATIVE is the one handing over (A); on return that's
    reversed -- the employee hands back (A) and the representative
    receives (B)."""
    date_parts = parse_iso_date(date_iso) if date_iso else None
    day, month, year = date_parts if date_parts else ("____", "____________", "____")

    employee = employee or {}
    employee_fields = {
        "fullname": employee.get("fullName") or "",
        "position": employee.get("position") or "",
        "department": employee.get("department") or "",
        "phone": employee.get("phone") or "",
    }
    party_a = employee_fields if not is_issue else COMPANY_REPRESENTATIVE
    party_b = employee_fields if is_issue else COMPANY_REPRESENTATIVE

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


_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

_ROOT_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '</Relationships>'
)


def _inventory_heading(text: str) -> ET.Element:
    p = ET.Element(f"{W}p")
    pPr = ET.SubElement(p, f"{W}pPr")
    ET.SubElement(pPr, f"{W}b")
    p.append(_make_run(text, bold=True))
    return p


def _inventory_paragraph(text: str) -> ET.Element:
    p = ET.Element(f"{W}p")
    p.append(_make_run(text))
    return p


def _inventory_list_paragraphs(items: list[str], empty_text: str) -> list[ET.Element]:
    if not items:
        return [_inventory_paragraph(empty_text)]
    return [_inventory_paragraph(f"— {text}") for text in items]


def generate_inventory_act(
    *,
    session: dict,
    missing_assets: list[dict],
    wrong_location: list[dict],
    extra_codes: list[str],
) -> bytes:
    """Собрать .docx акт инвентаризации полностью программно (без внешнего шаблона).

    В отличие от generate_act() (акт выдачи/возврата), у инвентаризации нет
    подходящего готового шаблона — три разных списка расхождений вместо одной
    таблицы позиций. Строим минимальный, но валидный OOXML-пакет напрямую:
    [Content_Types].xml + _rels/.rels + word/document.xml — этого достаточно,
    чтобы Word/LibreOffice открыли файл.
    """
    body = ET.Element(f"{W}body")
    body.append(_inventory_heading(f"Акт инвентаризации № {session['id'][:8]}"))
    body.append(_inventory_paragraph(f"Начата: {session.get('startedAt') or ''}"))
    body.append(_inventory_paragraph(f"Завершена: {session.get('finishedAt') or ''}"))
    body.append(_inventory_paragraph(f"Исполнитель: {session.get('startedBy') or ''}"))

    body.append(_inventory_heading("Не найдено"))
    missing_texts = [
        f"{item.get('name', '')} ({item.get('inventoryNumber', '') or 'без инв. номера'})"
        for item in missing_assets
    ]
    for p in _inventory_list_paragraphs(missing_texts, "Все позиции найдены."):
        body.append(p)

    body.append(_inventory_heading("Не на своём месте"))
    wrong_location_texts = [
        f"{item.get('name', '')} ({item.get('inventoryNumber', '') or 'без инв. номера'}): "
        f"учтено «{item.get('expectedLocation', '')}», найдено «{item.get('foundLocation', '')}»"
        for item in wrong_location
    ]
    for p in _inventory_list_paragraphs(wrong_location_texts, "Расхождений по местоположению нет."):
        body.append(p)

    body.append(_inventory_heading("Лишнее (нераспознанные коды)"))
    for p in _inventory_list_paragraphs(list(extra_codes), "Лишних кодов не обнаружено."):
        body.append(p)

    ET.SubElement(body, f"{W}sectPr")

    document = ET.Element(f"{W}document")
    # No explicit xmlns:w attribute here: `ET.register_namespace("w", W_NS)`
    # (module import time, above) already makes ET.tostring() emit
    # xmlns:w="..." on this root element automatically. Setting it again as a
    # literal attribute produced a DUPLICATE xmlns:w attribute in the
    # serialized XML — well-formed enough to zip and pass zipfile.testzip(),
    # but real Word/LibreOffice refuse to open the resulting document.xml
    # (duplicate attribute is a fatal XML well-formedness error). Found by
    # actually opening a generated .docx in Word via COM automation.
    document.append(body)

    document_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + ET.tostring(document, encoding="UTF-8")
    )

    out_buffer = io.BytesIO()
    with zipfile.ZipFile(out_buffer, "w", zipfile.ZIP_DEFLATED) as out_zip:
        out_zip.writestr("[Content_Types].xml", _CONTENT_TYPES_XML)
        out_zip.writestr("_rels/.rels", _ROOT_RELS_XML)
        out_zip.writestr("word/document.xml", document_xml)
    return out_buffer.getvalue()


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
