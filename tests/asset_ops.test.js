const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAllocation } = require('../asset_ops.js');

// ─── выдача сотруднику ───────────────────────────────────────────

test('первая выдача сотруднику заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 2 });
  assert.deepEqual(allocations, [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }]);
});

test('повторная выдача тому же сотруднику увеличивает существующую запись', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 3 });
  assert.equal(allocations.length, 1, 'запись не должна задваиваться');
  assert.equal(allocations[0].quantity, 5);
});

test('выдача другому сотруднику не трогает чужую запись', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  mergeAllocation(allocations, { employeeId: 'emp_2', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 2);
  assert.equal(allocations[1].quantity, 1);
});

// ─── выдача отделу и на объект ───────────────────────────────────

test('первая выдача отделу заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { department: 'Бухгалтерия', quantity: 4 });
  assert.deepEqual(allocations, [{ employeeId: null, department: 'Бухгалтерия', site: '', quantity: 4 }]);
});

test('повторная выдача тому же отделу увеличивает существующую запись', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', quantity: 4 }];
  mergeAllocation(allocations, { department: 'Бухгалтерия', quantity: 2 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 6);
});

test('первая выдача на объект заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { site: 'Склад №2', quantity: 1 });
  assert.deepEqual(allocations, [{ employeeId: null, department: '', site: 'Склад №2', quantity: 1 }]);
});

test('повторная выдача на тот же объект увеличивает существующую запись', () => {
  const allocations = [{ employeeId: null, department: '', site: 'Склад №2', quantity: 1 }];
  mergeAllocation(allocations, { site: 'Склад №2', quantity: 5 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 6);
});

// ─── получатели не путаются между собой ──────────────────────────

test('выдача сотруднику не вливается в запись его отдела', () => {
  // Сотрудник из "Бухгалтерии" и сама "Бухгалтерия" — разные получатели:
  // иначе возврат от сотрудника списал бы количество у отдела.
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', quantity: 4 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 4, 'запись отдела не должна меняться');
});

test('выдача отделу не вливается в запись сотрудника', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  mergeAllocation(allocations, { department: 'Бухгалтерия', quantity: 3 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 2);
});

test('выдача на объект не вливается в запись отдела', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', quantity: 4 }];
  mergeAllocation(allocations, { site: 'Склад №2', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 4);
});

test('выдача отделу не вливается в запись объекта', () => {
  const allocations = [{ employeeId: null, department: '', site: 'Склад №2', quantity: 1 }];
  mergeAllocation(allocations, { department: 'Бухгалтерия', quantity: 2 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 1);
});

test('разные отделы не сливаются', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', quantity: 4 }];
  mergeAllocation(allocations, { department: 'Отдел кадров', quantity: 1 });
  assert.equal(allocations.length, 2);
});

// ─── защита от порчи количеств ───────────────────────────────────

test('нулевое количество отклоняется', () => {
  assert.throws(() => mergeAllocation([], { employeeId: 'emp_1', quantity: 0 }), /количество/i);
});

test('отрицательное количество отклоняется', () => {
  // Иначе выдача тихо уменьшила бы уже выданное.
  assert.throws(() => mergeAllocation([], { employeeId: 'emp_1', quantity: -3 }), /количество/i);
});

test('нечисловое количество отклоняется', () => {
  assert.throws(() => mergeAllocation([], { employeeId: 'emp_1', quantity: 'много' }), /количество/i);
});

test('выдача без получателя отклоняется', () => {
  // Запись без получателя означала бы "выдано в никуда": количество ушло
  // бы из доступного остатка, а вернуть его было бы некому.
  assert.throws(() => mergeAllocation([], { quantity: 1 }), /получател/i);
});

test('отклонённая выдача не меняет список', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  assert.throws(() => mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 0 }));
  assert.deepEqual(allocations, [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }]);
});

// ─── возвращаемое значение ───────────────────────────────────────

test('возвращает затронутую запись', () => {
  const allocations = [];
  const entry = mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 2 });
  assert.equal(entry, allocations[0]);
});
