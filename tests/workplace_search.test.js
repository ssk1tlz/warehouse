const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWorkplaces } = require('../asset_ops.js');

// Поиск стола в окне этикеток: по названию, внутреннему коду WP-NNNN,
// отделу и тому, кто за столом сидит (ownerName подставляет app.js).
// Нормализация — как у поиска сотрудников: ё/е, узбекские буквы.

const workplaces = [
  { id: 'w3', name: 'Стол 3', code: 'WP-0003', department: 'Бухгалтерия', ownerName: 'Цой Марина Василевна' },
  { id: 'w4', name: 'Стол 4', code: 'WP-0004', department: 'Бухгалтерия', ownerName: 'Бельтикова Эльмира' },
  { id: 'w9', name: 'Брусчатка Цех Будка', code: 'WP-0001', department: 'Цех', ownerName: '' },
];
const ids = (list) => list.map((workplace) => workplace.id);

test('пустой запрос возвращает все места', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, '')), ['w3', 'w4', 'w9']);
});

test('по названию стола', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'стол 4')), ['w4']);
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'будка')), ['w9']);
});

test('по внутреннему коду', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'wp-0003')), ['w3']);
});

test('по отделу', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'бухгалтерия')), ['w3', 'w4']);
});

test('по тому, кто сидит за столом', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'бельтикова')), ['w4']);
});

test('слова в любом порядке', () => {
  assert.deepEqual(ids(searchWorkplaces(workplaces, 'цой стол')), ['w3']);
});

test('ничего не найдено — пусто', () => {
  assert.deepEqual(searchWorkplaces(workplaces, 'склад'), []);
});
