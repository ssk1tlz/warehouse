import io
import json
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

import updates


@pytest.mark.parametrize("text,expected", [
    ("1.2.3", (1, 2, 3)),
    ("v1.2.3", (1, 2, 3)),
    ("V1.2.3", (1, 2, 3)),
    ("  v1.2.3  ", (1, 2, 3)),
])
def test_parse_version_accepts_tags_with_and_without_prefix(text, expected):
    assert updates.parse_version(text) == expected


@pytest.mark.parametrize("text", ["", None, "1.2", "latest", "v1.2.x", "1.2.3.4"])
def test_parse_version_rejects_anything_it_cannot_understand(text):
    assert updates.parse_version(text) is None


@pytest.mark.parametrize("candidate,current,expected", [
    ("1.0.1", "1.0.0", True),
    ("1.1.0", "1.0.9", True),
    ("2.0.0", "1.99.99", True),
    ("1.0.0", "1.0.0", False),
    ("1.0.0", "1.0.1", False),
    ("1.0.10", "1.0.9", True),
    ("мусор", "1.0.0", False),
    ("1.0.1", "мусор", False),
])
def test_is_newer(candidate, current, expected):
    assert updates.is_newer(candidate, current) is expected


def _fake_response(payload):
    class _Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.close()
            return False

    return _Response(json.dumps(payload).encode("utf-8"))


def test_fetch_latest_release_returns_version_and_url(monkeypatch):
    payload = {"tag_name": "v1.2.0", "html_url": "https://github.com/ssk1tlz/warehouse/releases/tag/v1.2.0"}
    monkeypatch.setattr(updates.urllib.request, "urlopen", lambda *a, **kw: _fake_response(payload))
    assert updates.fetch_latest_release() == {
        "version": "1.2.0",
        "url": "https://github.com/ssk1tlz/warehouse/releases/tag/v1.2.0",
    }


@pytest.mark.parametrize("failure", [
    urllib.error.URLError("нет сети"),
    urllib.error.HTTPError("url", 404, "Not Found", {}, None),
    TimeoutError("таймаут"),
    ValueError("невалидный json"),
])
def test_fetch_latest_release_is_silent_on_every_failure(monkeypatch, failure):
    # Никакая сетевая проблема не должна всплывать наружу: проверка
    # обновлений строго опциональна и не имеет права ничего ломать.
    def _raise(*args, **kwargs):
        raise failure

    monkeypatch.setattr(updates.urllib.request, "urlopen", _raise)
    assert updates.fetch_latest_release() is None


def test_fetch_latest_release_ignores_a_release_without_a_usable_tag(monkeypatch):
    monkeypatch.setattr(updates.urllib.request, "urlopen",
                        lambda *a, **kw: _fake_response({"tag_name": "nightly", "html_url": "x"}))
    assert updates.fetch_latest_release() is None


def test_should_check_is_true_when_never_checked():
    assert updates.should_check({}, datetime.now(timezone.utc)) is True


def test_should_check_is_false_within_the_interval():
    now = datetime.now(timezone.utc)
    cache = {"lastCheckedAt": (now - timedelta(hours=1)).isoformat()}
    assert updates.should_check(cache, now) is False


def test_should_check_is_true_after_the_interval():
    now = datetime.now(timezone.utc)
    cache = {"lastCheckedAt": (now - timedelta(hours=25)).isoformat()}
    assert updates.should_check(cache, now) is True


def test_should_check_is_true_when_the_stamp_is_unreadable():
    assert updates.should_check({"lastCheckedAt": "не дата"}, datetime.now(timezone.utc)) is True


def test_cache_round_trips(tmp_path):
    cache_path = tmp_path / "update_check.json"
    updates.write_cache(cache_path, "1.2.0", "https://example/release")
    cache = updates.read_cache(cache_path)
    assert cache["latestVersion"] == "1.2.0"
    assert cache["releaseUrl"] == "https://example/release"
    assert updates.parse_version(cache["latestVersion"]) is not None


def test_read_cache_returns_empty_dict_for_a_missing_or_broken_file(tmp_path):
    assert updates.read_cache(tmp_path / "нет.json") == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{не json", encoding="utf-8")
    assert updates.read_cache(broken) == {}


def test_failed_check_does_not_touch_the_cache(tmp_path, monkeypatch):
    # Иначе одна неудачная попытка при отсутствии сети подавила бы проверку
    # ещё на сутки — интервал считается от последнего УСПЕШНОГО запроса.
    cache_path = tmp_path / "update_check.json"
    monkeypatch.setattr(updates, "fetch_latest_release", lambda *a, **kw: None)
    assert updates.check_now(cache_path) is None
    assert not cache_path.exists()
