"""Поднять версию продукта одной командой.

VERSION — единственный редактируемый источник версии. Остальные файлы
версии генерируются из него и коммитятся, чтобы и десктоп, и мобильное
приложение всегда видели одно и то же число без отдельного шага генерации
перед запуском.

    python bump_version.py patch     # 1.0.0 -> 1.0.1
    python bump_version.py --check   # проверить, что файлы в синхроне
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION_FILE = ROOT / "VERSION"
MOBILE_VERSION_JS = ROOT / "mobile" / "www" / "js" / "version.js"
ANDROID_VERSION_PROPERTIES = ROOT / "mobile" / "android" / "version.properties"

PARTS = ("major", "minor", "patch")


def parse(version: str) -> tuple[int, int, int]:
    pieces = version.strip().split(".")
    if len(pieces) != 3:
        raise ValueError(f"Версия должна быть вида X.Y.Z, получено: {version!r}")
    try:
        major, minor, patch = (int(piece) for piece in pieces)
    except ValueError:
        raise ValueError(f"Версия должна состоять из чисел, получено: {version!r}") from None
    return major, minor, patch


def next_version(current: str, part: str) -> str:
    major, minor, patch = parse(current)
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    elif part == "patch":
        patch += 1
    else:
        raise ValueError(f"Часть версии должна быть одной из {PARTS}, получено: {part!r}")
    return f"{major}.{minor}.{patch}"


def version_code(version: str) -> int:
    """Целочисленный versionCode для Android.

    Ограничение схемы: minor и patch должны быть меньше 100. При текущем
    темпе релизов запас достаточный; задокументировано в docs/RELEASING.md.
    """
    major, minor, patch = parse(version)
    if minor >= 100 or patch >= 100:
        raise ValueError(
            f"minor и patch должны быть меньше 100 для формулы versionCode, получено: {version!r}"
        )
    return major * 10000 + minor * 100 + patch


def render_files(version: str) -> dict[Path, str]:
    """Путь -> ожидаемое содержимое. Чистая функция, ничего не пишет на диск."""
    return {
        VERSION_FILE: f"{version}\n",
        MOBILE_VERSION_JS: f"window.APP_VERSION = '{version}';\n",
        ANDROID_VERSION_PROPERTIES: (
            "# Сгенерировано bump_version.py — не редактировать вручную.\n"
            f"versionName={version}\n"
            f"versionCode={version_code(version)}\n"
        ),
    }


def write_version_files(version: str) -> None:
    for path, text in render_files(version).items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def current_version() -> str:
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def check_in_sync() -> list[str]:
    """Имена файлов, чьё содержимое разошлось с VERSION (пустой список = всё в порядке)."""
    version = current_version()
    stale = []
    for path, expected in render_files(version).items():
        try:
            actual = path.read_text(encoding="utf-8")
        except OSError:
            stale.append(path.name)
            continue
        if actual.replace("\r\n", "\n") != expected:
            stale.append(path.name)
    return stale


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 2
    if argv[0] == "--check":
        stale = check_in_sync()
        if stale:
            print("Файлы версии рассинхронизованы: " + ", ".join(stale))
            print("Выполните: python bump_version.py --sync")
            return 1
        print(f"Версия {current_version()}, все файлы в синхроне.")
        return 0
    if argv[0] == "--sync":
        write_version_files(current_version())
        print(f"Файлы версии перезаписаны из VERSION ({current_version()}).")
        return 0
    if argv[0] not in PARTS:
        print(__doc__)
        return 2
    new_version = next_version(current_version(), argv[0])
    write_version_files(new_version)
    print(new_version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
