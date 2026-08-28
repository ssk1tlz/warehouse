import pytest

import bump_version


@pytest.mark.parametrize("current,part,expected", [
    ("1.0.0", "patch", "1.0.1"),
    ("1.0.9", "patch", "1.0.10"),
    ("1.2.3", "minor", "1.3.0"),
    ("1.2.3", "major", "2.0.0"),
    ("0.9.9", "major", "1.0.0"),
])
def test_next_version(current, part, expected):
    assert bump_version.next_version(current, part) == expected


def test_next_version_rejects_an_unknown_part():
    with pytest.raises(ValueError):
        bump_version.next_version("1.0.0", "build")


def test_next_version_rejects_a_malformed_current_version():
    with pytest.raises(ValueError):
        bump_version.next_version("1.0", "patch")


@pytest.mark.parametrize("version,expected", [
    ("1.0.0", 10000),
    ("1.0.1", 10001),
    ("1.2.3", 10203),
    ("2.0.0", 20000),
])
def test_version_code_is_monotonic_and_matches_the_documented_formula(version, expected):
    assert bump_version.version_code(version) == expected


def test_version_code_beats_the_legacy_android_version_code():
    # build.gradle до этого этапа стоял на versionCode 1; любая новая версия
    # обязана быть больше, иначе Android откажется ставить обновление.
    assert bump_version.version_code("1.0.0") > 1


def test_version_code_rejects_minor_or_patch_gte_100():
    # Ограничение схемы: формула major*10000 + minor*100 + patch требует
    # minor < 100 и patch < 100, иначе возможна коллизия. Например,
    # 1.0.100 и 1.1.0 обе дают 10100, что приводит к тому, что Android
    # отказывает установить обновление без видимой причины.
    with pytest.raises(ValueError):
        bump_version.version_code("1.100.0")
    with pytest.raises(ValueError):
        bump_version.version_code("1.0.100")


def test_generated_files_are_committed_in_sync_with_the_version_file():
    # VERSION — единственный редактируемый источник; version.js и
    # version.properties генерируются из него и коммитятся. Этот тест ловит
    # ситуацию «подняли VERSION вручную, забыли прогнать bump_version.py».
    assert bump_version.check_in_sync() == []


def test_render_files_produces_the_expected_contents():
    rendered = {path.name: text for path, text in bump_version.render_files("1.2.3").items()}
    assert rendered["VERSION"] == "1.2.3\n"
    assert rendered["version.js"] == "window.APP_VERSION = '1.2.3';\n"
    assert (
        rendered["version.properties"]
        == "# Сгенерировано bump_version.py — не редактировать вручную.\n"
        "versionName=1.2.3\n"
        "versionCode=10203\n"
    )
