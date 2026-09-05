const test = require('node:test');
const assert = require('node:assert/strict');
const { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel, getAllocatedQuantity, getAvailableQuantity, getIssuableQuantity } = require('../www/js/format.js');

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

test('manual repair status on the row wins over the computed one', () => {
  const asset = { status: 'repair', quantity: 5, retiredQuantity: 0, repairQuantity: 0, allocations: [] };
  assert.equal(getAssetStatus(asset), 'repair');
});

test('manual retired status on the row wins over the computed one', () => {
  const asset = { status: 'retired', quantity: 5, retiredQuantity: 0, repairQuantity: 0, allocations: [] };
  assert.equal(getAssetStatus(asset), 'retired');
});

test('retired when quantity hit zero via retirement', () => {
  const asset = { status: 'in_stock', quantity: 0, retiredQuantity: 3, repairQuantity: 0, allocations: [] };
  assert.equal(getAssetStatus(asset), 'retired');
});

test('derived repair status when fully in repair with no available quantity', () => {
  const asset = { status: 'in_stock', quantity: 2, retiredQuantity: 0, repairQuantity: 2, allocations: [] };
  assert.equal(getAssetStatus(asset), 'repair');
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

test('holderLabel returns unknown employee fallback when employeeId not found', () => {
  const employeesById = new Map();
  assert.equal(holderLabel({ employeeId: 'missing_emp', department: '', site: '' }, employeesById), 'Неизвестный сотрудник');
});

test('holderLabel checks site before department', () => {
  const employeesById = new Map();
  assert.equal(holderLabel({ employeeId: null, department: 'IT', site: 'Склад №2' }, employeesById), 'Объект: Склад №2');
});

test('holderLabel uses correct wording for department and site', () => {
  const employeesById = new Map();
  assert.equal(holderLabel({ employeeId: null, department: 'IT', site: '' }, employeesById), 'Отдел: IT');
  assert.equal(holderLabel({ employeeId: null, department: '', site: 'Склад №2' }, employeesById), 'Объект: Склад №2');
});

test('holderLabel returns unknown fallback when no employee, site, or department', () => {
  const employeesById = new Map();
  assert.equal(holderLabel({ employeeId: null, department: '', site: '' }, employeesById), 'Неизвестно');
});

// ─── Техника общего пользования ────────────────────────────────────────────

const sharedUps = () => ({
  status: 'in_stock', quantity: 1, retiredQuantity: 0, repairQuantity: 0, isShared: true,
  allocations: [{ employeeId: 'emp_1', quantity: 1 }, { employeeId: 'emp_2', quantity: 1 }],
});

test('общая позиция: занято считается по максимуму держателя, а не суммой', () => {
  assert.equal(getAllocatedQuantity(sharedUps()), 1);
  assert.equal(getAllocatedQuantity({ ...sharedUps(), isShared: false }), 2);
});

test('общая позиция у двоих: на складе ноль, но выдать ещё одному можно', () => {
  const asset = sharedUps();
  assert.equal(getAvailableQuantity(asset), 0);
  assert.equal(getIssuableQuantity(asset), 1);
});

test('общая позиция: тому, у кого она уже есть, второй раз не выдать', () => {
  const asset = sharedUps();
  assert.equal(getIssuableQuantity(asset, asset.allocations[0]), 0);
});

test('общая позиция в ремонте не выдаётся', () => {
  assert.equal(getIssuableQuantity({ ...sharedUps(), repairQuantity: 1 }), 0);
});

test('обычная позиция: getIssuableQuantity равен свободному остатку', () => {
  const asset = { status: 'in_stock', quantity: 5, retiredQuantity: 0, repairQuantity: 1, allocations: [{ quantity: 2 }] };
  assert.equal(getIssuableQuantity(asset), 2);
  assert.equal(getIssuableQuantity(asset), getAvailableQuantity(asset));
});

test('общая позиция у двоих числится выданной', () => {
  assert.equal(getAssetStatus(sharedUps()), 'assigned');
});
