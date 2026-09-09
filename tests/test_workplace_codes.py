import sqlite3

import pytest

import workplace_codes


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE workplaces (id TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '')"
    )
    yield connection
    connection.close()


def test_next_number_starts_at_one_when_empty(conn):
    assert workplace_codes.next_number(conn) == 1


def test_next_number_is_max_plus_one(conn):
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', 'WP-0003')")
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w2', 'WP-0007')")
    assert workplace_codes.next_number(conn) == 8


def test_next_number_ignores_blank_codes(conn):
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', '')")
    assert workplace_codes.next_number(conn) == 1


def test_next_number_ignores_codes_in_a_different_format(conn):
    # На случай ручной правки базы — не должно падать и не должно
    # считать это число.
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', 'NB-0099')")
    assert workplace_codes.next_number(conn) == 1


def test_assign_code_formats_with_leading_zeros():
    assert workplace_codes.assign_code(1) == "WP-0001"
    assert workplace_codes.assign_code(42) == "WP-0042"
