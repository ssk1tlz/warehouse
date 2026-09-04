from datetime import date
import sqlite3

import server


def _asset(**overrides):
    base = {
        "id": "a1", "name": "Ноутбук", "quantity": 5, "repairQuantity": 0,
        "minQuantity": 0, "warrantyEnd": "", "status": "in_stock", "repairDate": "",
        "allocations": [],
    }
    base.update(overrides)
    return base


DEFAULT_SETTINGS = {"attentionWarrantyDays": 30, "attentionRepairDays": 14}


def test_warranty_ending_within_threshold_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-09-20")  # 16 дней вперёд, порог 30
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" and i["assetId"] == "a1" for i in items)


def test_warranty_already_expired_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-08-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" and i["assetId"] == "a1" for i in items)


def test_warranty_far_in_the_future_is_not_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2027-01-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert not any(i["type"] == "warranty" for i in items)


def test_warranty_exactly_at_threshold_boundary_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-10-04")  # ровно +30 дней
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" for i in items)


def test_empty_warranty_end_is_never_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert not any(i["type"] == "warranty" for i in items)


def test_retired_zero_quantity_asset_is_never_flagged():
    # A retired asset (quantity decremented to 0; this codebase's established
    # semantics never delete the row) with BOTH an expired warranty and a
    # positive minQuantity must not generate permanent, unclearable attention
    # noise — same class of bug a prior stage's final review already had to
    # fix in getAllAssets()/apply_inventory_complete()/handle_inventory_act().
    today = date(2026, 9, 4)
    asset = _asset(quantity=0, warrantyEnd="2026-01-01", minQuantity=3, allocations=[])
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert items == []


def test_low_stock_when_available_below_minimum():
    asset = _asset(quantity=5, repairQuantity=0, minQuantity=3,
                    allocations=[{"employeeId": "e1", "department": "", "site": "", "quantity": 3}])
    # available = 5 - 3(allocated) - 0(repair) = 2 < minQuantity(3)
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert any(i["type"] == "low_stock" and i["assetId"] == "a1" for i in items)


def test_low_stock_not_flagged_when_available_equals_minimum():
    asset = _asset(quantity=5, repairQuantity=0, minQuantity=2,
                    allocations=[{"employeeId": "e1", "department": "", "site": "", "quantity": 3}])
    # available = 5 - 3 - 0 = 2 == minQuantity(2) -> не сигнал
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "low_stock" for i in items)


def test_low_stock_accounts_for_repair_quantity():
    asset = _asset(quantity=5, repairQuantity=2, minQuantity=3, allocations=[])
    # available = 5 - 0 - 2 = 3 == minQuantity(3) -> не сигнал
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "low_stock" for i in items)


def test_long_repair_flagged_past_threshold():
    asset = _asset(status="repair", repairQuantity=1, repairDate="2026-08-10")
    # 2026-09-04 - 2026-08-10 = 25 дней > 14
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert any(i["type"] == "long_repair" and i["assetId"] == "a1" for i in items)


def test_long_repair_not_flagged_before_threshold():
    asset = _asset(status="repair", repairQuantity=1, repairDate="2026-09-01")
    # 3 дня < 14
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "long_repair" for i in items)


def test_long_repair_ignores_assets_with_no_repair_quantity():
    asset = _asset(status="in_stock", repairQuantity=0, repairDate="2026-01-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "long_repair" for i in items)


def test_export_state_includes_attention_items(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    # Without this, export_state() -> compute_attention_items() reads
    # attention thresholds from the REAL machine's
    # %ProgramData%\Warehouse\config.json — currently harmless (this test's
    # warranty date is far enough in the past that any reasonable real
    # config still flags it) but not properly isolated from the host
    # machine's state, unlike every other test in this suite that touches
    # config.
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    server.init_db()
    with sqlite3.connect(server.DB_PATH) as conn:
        conn.execute(
            "INSERT INTO assets (id, name, quantity, warranty_end) VALUES (?, ?, ?, ?)",
            ("a1", "Монитор", 1, "2026-08-01"),
        )
        conn.commit()
    state = server.export_state()
    assert any(i["assetId"] == "a1" and i["type"] == "warranty" for i in state["attentionItems"])
