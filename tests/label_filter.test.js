const test = require('node:test');
const assert = require('node:assert/strict');
const { filterLabelAssets } = require('../asset_ops.js');

// Таблица в окне этикеток. Выбор хранится отдельно (labelSelection в
// app.js), поэтому фильтр только решает, что ПОКАЗАТЬ, и не может
// потерять уже отмеченное: выбрал у одного сотрудника, переключился на
// другого — первое осталось выбранным и суммируется со вторым.

const assets = [
  { id: 'nb', name: 'Ноутбук Lenovo', category: 'Ноутбук', inventoryNumber: 'NB-0042', location: 'Офис', labelPrintedAt: null },
  { id: 'mon', name: 'Монитор Samsung', category: 'Монитор', inventoryNumber: 'MON-0018', location: 'Офис', labelPrintedAt: '2026-09-01' },
  { id: 'ms', name: 'Мышь Logitech', category: 'Мышь', inventoryNumber: 'MUS-0041', location: 'Склад', labelPrintedAt: null },
  { id: 'kb', name: 'Клавиатура Logitech', category: 'Клавиатура', inventoryNumber: 'KEY-0025', location: 'Склад', labelPrintedAt: null },
];
const ids = (list) => list.map((asset) => asset.id);

test('без фильтров показывается вся техника', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, {})), ['nb', 'mon', 'ms', 'kb']);
});

test('поиск техники — по словам в любом порядке', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, { query: 'logitech мышь' })), ['ms']);
  assert.deepEqual(ids(filterLabelAssets(assets, { query: 'MON-0018' })), ['mon']);
});

test('категория, место и «не печатались» сужают список', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, { category: 'Мышь' })), ['ms']);
  assert.deepEqual(ids(filterLabelAssets(assets, { location: 'Склад' })), ['ms', 'kb']);
  assert.deepEqual(ids(filterLabelAssets(assets, { onlyUnprinted: true })), ['nb', 'ms', 'kb']);
});

test('выбранный сотрудник — показывается только его техника', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, { onlyAssetIds: new Set(['nb', 'ms']) })), ['nb', 'ms']);
});

test('у сотрудника без техники таблица пустая, а не вся техника', () => {
  // Пустое множество — «у него ничего нет», а null — «сотрудник не выбран».
  assert.deepEqual(filterLabelAssets(assets, { onlyAssetIds: new Set() }), []);
});

test('поиск техники работает внутри техники сотрудника', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, { onlyAssetIds: ['nb', 'ms', 'kb'], query: 'logitech' })), ['ms', 'kb']);
});

test('«только выбранные» показывает набранное у разных сотрудников', () => {
  assert.deepEqual(ids(filterLabelAssets(assets, { selectedIds: ['kb', 'nb'] })), ['nb', 'kb']);
});

test('«только выбранные» при пустом выборе — пусто', () => {
  assert.deepEqual(filterLabelAssets(assets, { selectedIds: [] }), []);
});
