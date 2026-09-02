"""Проверка новой версии через публичные GitHub Releases.

Полностью опциональна и полностью тиха: любая сетевая ошибка, таймаут,
недоступность GitHub или мусор в ответе означают «ничего не показываем».
Никакой телеметрии — уходит только анонимный GET к публичному API, никакие
данные пользователя никуда не отправляются.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

GITHUB_REPOSITORY = "ssk1tlz/warehouse"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
CHECK_INTERVAL_SECONDS = 24 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 3

_VERSION_RE = re.compile(r"^[vV]?(\d+)\.(\d+)\.(\d+)$")


def parse_version(text) -> tuple[int, int, int] | None:
    """'v1.2.3' / '1.2.3' -> (1, 2, 3). Всё остальное -> None."""
    if not isinstance(text, str):
        return None
    match = _VERSION_RE.match(text.strip())
    if not match:
        return None
    return tuple(int(piece) for piece in match.groups())


def is_newer(candidate, current) -> bool:
    """True, только если обе версии разобраны и candidate строго новее."""
    parsed_candidate = parse_version(candidate)
    parsed_current = parse_version(current)
    if parsed_candidate is None or parsed_current is None:
        return False
    return parsed_candidate > parsed_current


def fetch_latest_release(url: str = LATEST_RELEASE_URL,
                         timeout: int = REQUEST_TIMEOUT_SECONDS) -> dict | None:
    """{'version': '1.2.0', 'url': '...'} либо None при любой проблеме."""
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "WarehouseApp"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — намеренно широко: проверка не имеет права ломать приложение
        return None
    if not isinstance(payload, dict):
        return None
    tag = payload.get("tag_name")
    parsed = parse_version(tag)
    if parsed is None:
        return None
    return {
        "version": ".".join(str(piece) for piece in parsed),
        "url": str(payload.get("html_url") or f"https://github.com/{GITHUB_REPOSITORY}/releases"),
    }


def read_cache(path: Path) -> dict:
    try:
        cache = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return cache if isinstance(cache, dict) else {}


def write_cache(path: Path, version: str, release_url: str) -> None:
    payload = {
        "lastCheckedAt": datetime.now(timezone.utc).isoformat(),
        "latestVersion": version,
        "releaseUrl": release_url,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def should_check(cache: dict, now: datetime) -> bool:
    """Пора ли спрашивать GitHub.

    Интервал отсчитывается от последнего УСПЕШНОГО запроса: неудачная
    попытка кэш не трогает, иначе временное отсутствие сети подавило бы
    проверку на целые сутки.
    """
    stamp = cache.get("lastCheckedAt")
    if not isinstance(stamp, str):
        return True
    try:
        last = datetime.fromisoformat(stamp)
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() >= CHECK_INTERVAL_SECONDS


def check_now(cache_path: Path, url: str = LATEST_RELEASE_URL) -> dict | None:
    """Спросить GitHub и записать кэш при успехе. None — если не вышло."""
    release = fetch_latest_release(url)
    if release is None:
        return None
    write_cache(cache_path, release["version"], release["url"])
    return release
