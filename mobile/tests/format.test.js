const test = require('node:test');
const assert = require('node:assert/strict');
const { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel } = require('../www/js/format.js');

test('in_stock when nothing is allocated', () => {
  assert.equal(getAssetStatus({ status: 'in_stock', quantity: 5, retiredQuantity: 0, repairQuantity: 0, allocations: [] }), 'in_stock');
});

test('assigned when fully allocated', () => {
  const asset = { status: 'in_stock', quantity: 2, retiredQuantity: 0, repairQuantity: 0, allocations: [{ quantity: 2 }] };
  assert.equal(getAssetStatus(asset), 'assigned');
});

test('partial when some but not all is allocated', () => {
  const asset = { status: 'in_stock', quantity: 5, retiredQuantity: 0, repairQuantity: 0, allocations: [{ quantity: 2 }] };
  assert.equal(getAssetStatus(asset), 'partial');
});

test('manual repair/retired status on the row wins over the computed one', () => {
  const asset = { status: 'repair', quantity: 5, retiredQuantity: 0, repairQuantity: 0, allocations: [] };
  assert.equal(getAssetStatus(asset), 'repair');
});

test('retired when quantity hit zero via retirement', () => {
  const asset = { status: 'in_stock', quantity: 0, retiredQuantity: 3, repairQuantity: 0, allocations: [] };
  assert.equal(getAssetStatus(asset), 'retired');
});

test('status labels are in Russian and cover every status', () => {
  for (const status of ['in_stock', 'assigned', 'partial', 'repair', 'retired']) {
    assert.equal(typeof STATUS_LABELS[status], 'string');
    assert.ok(STATUS_LABELS[status].length > 0);
  }
});

test('movement labels cover every action type the app can submit', () => {
  for (const type of ['issue', 'return', 'repair', 'repair_return', 'retire']) {
    assert.equal(typeof MOVEMENT_LABELS[type], 'string');
  }
});

test('holderLabel resolves an employee allocation to a full name', () => {
  const employeesById = new Map([['emp_1', { fullName: 'Иванов Иван' }]]);
  assert.equal(holderLabel({ employeeId: 'emp_1', department: '', site: '' }, employeesById), 'Иванов Иван');
});

test('holderLabel falls back to department/site labels when there is no employee', () => {
  const employeesById = new Map();
  assert.equal(holderLabel({ employeeId: null, department: 'IT', site: '' }, employeesById), 'Отдел «IT»');
  assert.equal(holderLabel({ employeeId: null, department: '', site: 'Склад №2' }, employeesById), 'Объект «Склад №2»');
});
