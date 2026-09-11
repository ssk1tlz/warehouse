const test = require('node:test');
const assert = require('node:assert/strict');
const { searchEmployees } = require('../asset_ops.js');

// Поиск сотрудника в окне этикеток: 133 фамилии в выпадающем списке
// без поиска — это пролистывание. Написание ФИО в базе разнобойное,
// поэтому поиск терпим к тем же различиям, что и проверка дублей
// (normalizeFullName): ё/е, узбекские буквы, дефисы, порядок слов.

const employees = [
  { id: 'e1', fullName: 'Цой Марина Василевна', department: 'Бухгалтерия', position: 'Бухгалтер' },
  { id: 'e2', fullName: 'Абдуллайев Дониёр Ғайрат Ўғли', department: 'Цех', position: 'Мастер' },
  { id: 'e3', fullName: 'Петров-Водкин Пётр', department: 'IT', position: 'Инженер' },
  { id: 'e4', fullName: 'Саттарова Зебохон Асатуллойевна', department: 'Бухгалтерия', position: 'Кассир' },
];

const ids = (list) => list.map((employee) => employee.id);

test('пустой запрос возвращает всех', () => {
  assert.deepEqual(ids(searchEmployees(employees, '')), ['e1', 'e2', 'e3', 'e4']);
});

test('находит по части фамилии без учёта регистра', () => {
  assert.deepEqual(ids(searchEmployees(employees, 'цой')), ['e1']);
});

test('слова ищутся в любом порядке', () => {
  assert.deepEqual(ids(searchEmployees(employees, 'марина цой')), ['e1']);
});

test('узбекские буквы находятся через похожие русские', () => {
  // «Ғайрат» набирают как «Гайрат», «Ўғли» — как «Угли».
  assert.deepEqual(ids(searchEmployees(employees, 'гайрат угли')), ['e2']);
});

test('ё и е не различаются', () => {
  assert.deepEqual(ids(searchEmployees(employees, 'петр')), ['e3']);
  assert.deepEqual(ids(searchEmployees(employees, 'дониер')), ['e2']);
});

test('дефис в составной фамилии не мешает', () => {
  assert.deepEqual(ids(searchEmployees(employees, 'петров водкин')), ['e3']);
});

test('находит по отделу и должности', () => {
  assert.deepEqual(ids(searchEmployees(employees, 'бухгалтерия')), ['e1', 'e4']);
  assert.deepEqual(ids(searchEmployees(employees, 'кассир')), ['e4']);
});

test('ничего не найдено — пустой список', () => {
  assert.deepEqual(searchEmployees(employees, 'иванов'), []);
});
