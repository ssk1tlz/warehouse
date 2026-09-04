from datetime import date

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
