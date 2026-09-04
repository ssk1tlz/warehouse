import zipfile
from io import BytesIO
from xml.etree import ElementTree as ET

import act_generator


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


def test_generate_act_uses_custom_action_phrase_when_provided():
    docx_bytes = act_generator.generate_act(
        act_number=1, date_iso="2026-09-04",
        employee={"fullName": "Иванов И.И.", "position": "Инженер"},
        items=[{"name": "Ноутбук", "quantity": 1, "price": 1000}],
        is_issue=True,
        action_phrase="За Работником числится по состоянию на",
    )
    zf = zipfile.ZipFile(BytesIO(docx_bytes))
    document_xml = zf.read("word/document.xml").decode("utf-8")
    assert "За Работником числится по состоянию на" in document_xml
    assert act_generator.ISSUE_PHRASE not in document_xml
