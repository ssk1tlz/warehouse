import io
import zipfile
from io import BytesIO
from xml.etree import ElementTree as ET

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


def test_generate_inventory_act_returns_a_valid_docx_zip():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:30:00+00:00", "startedBy": "alan"},
        missing_assets=[{"name": "Монитор Dell", "inventoryNumber": "INV-010"}],
        wrong_location=[{"name": "Клавиатура", "inventoryNumber": "INV-011",
                          "expectedLocation": "Каб. 101", "foundLocation": "Каб. 202"}],
        extra_codes=["WH1:unknown-999"],
    )
    assert isinstance(data, bytes)
    zf = zipfile.ZipFile(BytesIO(data))
    names = zf.namelist()
    assert "word/document.xml" in names
    assert "[Content_Types].xml" in names
    assert "_rels/.rels" in names
    # zipfile.testzip() returns None when every member's CRC checks out.
    assert zf.testzip() is None


def test_generate_inventory_act_embeds_the_key_facts_as_readable_text():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:30:00+00:00", "startedBy": "alan"},
        missing_assets=[{"name": "Монитор Dell", "inventoryNumber": "INV-010"}],
        wrong_location=[], extra_codes=[],
    )
    zf = zipfile.ZipFile(BytesIO(data))
    document_xml = zf.read("word/document.xml").decode("utf-8")
    assert "alan" in document_xml
    assert "Монитор Dell" in document_xml
    assert "INV-010" in document_xml


def test_generate_inventory_act_document_xml_is_well_formed():
    # zipfile.testzip() only checks CRCs, not that word/document.xml is
    # actually well-formed XML — a stray duplicate xmlns:w attribute on the
    # root element passed CRC checks and substring assertions just fine, but
    # real Word/LibreOffice refused to open the resulting .docx (found by
    # opening a generated file in an actual Word instance via COM
    # automation). Re-parsing document.xml here catches that class of bug
    # cheaply, without needing a real Word/LibreOffice install in CI.
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:30:00+00:00", "startedBy": "alan"},
        missing_assets=[{"name": "Монитор Dell", "inventoryNumber": "INV-010"}],
        wrong_location=[{"name": "Клавиатура", "inventoryNumber": "INV-011",
                          "expectedLocation": "Каб. 101", "foundLocation": "Каб. 202"}],
        extra_codes=["WH1:unknown-999"],
    )
    zf = zipfile.ZipFile(BytesIO(data))
    document_xml = zf.read("word/document.xml")
    ET.fromstring(document_xml)  # raises ET.ParseError if not well-formed


def test_generate_inventory_act_handles_empty_lists_without_crashing():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:00:00+00:00", "startedBy": "alan"},
        missing_assets=[], wrong_location=[], extra_codes=[],
    )
    zf = zipfile.ZipFile(BytesIO(data))
    assert zf.testzip() is None


def test_generate_act_is_a_valid_docx_with_all_tokens_substituted():
    data = act_generator.generate_act(
        act_number=134, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=True,
    )
    zf = zipfile.ZipFile(io.BytesIO(data))
    assert zf.testzip() is None
    xml = _document_xml(data)
    ET.fromstring(xml)  # raises ET.ParseError if not well-formed — the load-bearing check for this task's string-surgery approach
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
    position_idx = xml.index(SAMPLE_EMPLOYEE["position"])
    department_idx = xml.index(SAMPLE_EMPLOYEE["department"])
    phone_idx = xml.index(SAMPLE_EMPLOYEE["phone"])
    assert party_a_idx < party_b_idx < name_idx
    assert party_a_idx < party_b_idx < position_idx
    assert party_a_idx < party_b_idx < department_idx
    assert party_a_idx < party_b_idx < phone_idx


def test_return_fills_party_a_handing_back_side_only():
    data = act_generator.generate_act(
        act_number=1, date_iso="2026-09-14", employee=SAMPLE_EMPLOYEE, items=SAMPLE_ITEMS, is_issue=False,
    )
    xml = _document_xml(data)
    party_a_idx = xml.index("Передающая сторона (сдал)")
    party_b_idx = xml.index("Принимающая сторона (принял)")
    name_idx = xml.index("Иванов Иван Иванович")
    position_idx = xml.index(SAMPLE_EMPLOYEE["position"])
    department_idx = xml.index(SAMPLE_EMPLOYEE["department"])
    phone_idx = xml.index(SAMPLE_EMPLOYEE["phone"])
    assert party_a_idx < name_idx < party_b_idx
    assert party_a_idx < position_idx < party_b_idx
    assert party_a_idx < department_idx < party_b_idx
    assert party_a_idx < phone_idx < party_b_idx


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
