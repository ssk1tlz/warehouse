const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAllocation } = require('../asset_ops.js');

// ─── выдача сотруднику ───────────────────────────────────────────

test('первая выдача сотруднику заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 2 });
  assert.deepEqual(allocations, [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }]);
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
  assert.deepEqual(allocations, [{ employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 4 }]);
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
  assert.deepEqual(allocations, [{ employeeId: null, department: '', site: 'Склад №2', workplaceId: '', quantity: 1 }]);
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

// ─── поиск техники ───────────────────────────────────────────────

const { searchAssets } = require('../asset_ops.js');

const CATALOG = [
  { id: 'a1', name: 'Samsung / S27E332H', category: 'Монитор', inventoryNumber: 'MON-0008', serialNumber: '08LPH9YN800154T' },
  { id: 'a2', name: 'HP / HP Laptop 15-fd0xxx', category: 'Ноутбук', inventoryNumber: 'NB-0005', serialNumber: 'Отсутствует' },
  { id: 'a3', name: 'A4Tech / OP-6200', category: 'Проводная компьютерная мышь', inventoryNumber: 'MUS-0011', serialNumber: '' },
  { id: 'a4', name: '3D Optical mouse', category: 'Проводная компьютерная мышь', inventoryNumber: 'MUS-0180' },
];

const ids = (rows) => rows.map((r) => r.id);

test('пустой запрос возвращает весь список', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, '')), ['a1', 'a2', 'a3', 'a4']);
});

test('запрос из одних пробелов возвращает весь список', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, '   ')), ['a1', 'a2', 'a3', 'a4']);
});

test('находит по наименованию без учёта регистра', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'samsung')), ['a1']);
});

test('находит по категории', () => {
  // Ровно то, что было сломано: поиск по слову вообще не работал.
  assert.deepEqual(ids(searchAssets(CATALOG, 'монитор')), ['a1']);
});

test('находит по инвентарному номеру целиком', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'MON-0008')), ['a1']);
});

test('находит по числовой части инвентарного номера', () => {
  // Старый поиск умел только цифры — новый обязан не растерять это.
  assert.deepEqual(ids(searchAssets(CATALOG, '0005')), ['a2']);
});

test('находит по серийному номеру', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, '08LPH9YN800154T')), ['a1']);
});

test('несколько слов ищутся вместе, в любом порядке', () => {
  // Тип лежит в категории, модель — в наименовании; порознь не найти.
  assert.deepEqual(ids(searchAssets(CATALOG, 'мышь a4tech')), ['a3']);
  assert.deepEqual(ids(searchAssets(CATALOG, 'a4tech мышь')), ['a3']);
});

test('слова, не совпавшие вместе, ничего не дают', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'мышь samsung')), []);
});

test('несуществующий запрос даёт пустой список', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'кофемашина')), []);
});

test('ё приводится к е', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'отсутствует')), ['a2']);
});

test('позиция без серийного номера не роняет поиск', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'optical')), ['a4']);
});

test('порядок исходного списка сохраняется', () => {
  assert.deepEqual(ids(searchAssets(CATALOG, 'mus')), ['a3', 'a4']);
});

// ─── выдача на рабочее место ─────────────────────────────────────

test('первая выдача на рабочее место заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.deepEqual(allocations, [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }]);
});

test('повторная выдача на тот же стол увеличивает существующую запись', () => {
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 2 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 3);
});

test('разные столы не сливаются', () => {
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { workplaceId: 'w2', quantity: 1 });
  assert.equal(allocations.length, 2);
});

test('выдача сотруднику не вливается в запись его стола', () => {
  // Сотрудник и стол, за которым он сидит, — разные получатели: иначе
  // возврат от человека списал бы количество со стола.
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 1, 'запись стола не должна меняться');
});

test('выдача на стол не вливается в запись сотрудника', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 2);
});

test('выдача на стол не вливается в запись отдела', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 4 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 4);
});

test('выдача на стол не вливается в запись объекта', () => {
  const allocations = [{ employeeId: null, department: '', site: 'АБЗ', workplaceId: '', quantity: 3 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 3);
});

test('старая запись без поля workplaceId считается записью сотрудника', () => {
  // Записи, пришедшие из базы до миграции 030, поля не имеют вовсе.
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 3);
});

test('выдача на стол без указанного стола отклоняется', () => {
  assert.throws(() => mergeAllocation([], { workplaceId: '', quantity: 1 }), /получател/i);
});

test('запись сотрудника создаётся с пустым workplaceId', () => {
  const allocations = [];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations[0].workplaceId, '');
});

// ─── сортировка движений по свежести ─────────────────────────────

const { movementSortValue, movementCreatedAt } = require('../asset_ops.js');

test('движение с датой сортируется по этой дате', () => {
  const value = movementSortValue({ id: 'mov_1_abc', date: '2026-08-15' });
  assert.equal(value, new Date('2026-08-15').getTime());
});

test('движение без даты сортируется по моменту создания из id', () => {
  const value = movementSortValue({ id: 'mov_1757321893821_a1b2c3', date: '' });
  assert.equal(value, 1757321893821);
});

test('движение без даты и без разбираемого id уходит в конец', () => {
  const value = movementSortValue({ id: 'не-по-шаблону', date: '' });
  assert.equal(value, Number.MIN_SAFE_INTEGER);
});

test('движение вовсе без id и без даты уходит в конец', () => {
  const value = movementSortValue({ date: null });
  assert.equal(value, Number.MIN_SAFE_INTEGER);
});

test('свежая выдача без даты сортируется выше старой выдачи с датой', () => {
  // Ровно сценарий бага: «Выдать сразу» только что создало запись без
  // даты — она не должна проваливаться ниже выдачи месячной давности.
  const freshUnknownDate = { id: `mov_${Date.now()}_a1b2c3`, date: '' };
  const oldDated = { id: 'mov_1_xyz', date: '2020-01-01' };
  const sorted = [oldDated, freshUnknownDate].sort((a, b) => movementSortValue(b) - movementSortValue(a));
  assert.deepEqual(sorted, [freshUnknownDate, oldDated]);
});

test('movementCreatedAt разбирает момент создания из id движения', () => {
  assert.equal(movementCreatedAt({ id: 'mov_1757321893821_a1b2c3' }), 1757321893821);
});

test('movementCreatedAt возвращает null для нераспознанного id', () => {
  assert.equal(movementCreatedAt({ id: 'не-по-шаблону' }), null);
});

test('movementCreatedAt возвращает null при отсутствии id', () => {
  assert.equal(movementCreatedAt({}), null);
});

test('два движения без даты и без разбираемого id сравниваются без NaN', () => {
  // Раньше сентинел -Infinity здесь давал -Infinity - (-Infinity) === NaN,
  // и sort() молча переставал их упорядочивать.
  const a = { id: 'a', date: '' };
  const b = { id: 'b', date: '' };
  assert.equal(Number.isNaN(movementSortValue(b) - movementSortValue(a)), false);
});

// ─── единственный сотрудник для этикетки ─────────────────────────

const { singleEmployeeId } = require('../asset_ops.js');

test('singleEmployeeId возвращает id единственного сотрудника', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});

test('singleEmployeeId возвращает null, если техника не закреплена за сотрудником', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 4 }];
  assert.equal(singleEmployeeId(allocations), null);
});

test('singleEmployeeId возвращает null для пустого списка выдач', () => {
  assert.equal(singleEmployeeId([]), null);
});

test('singleEmployeeId возвращает null, если техника закреплена за разными сотрудниками', () => {
  // Например, часть тиража расходников выдана одному, часть — другому:
  // на этикетке одно имя было бы неоднозначным, поэтому не печатаем ни одно.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: 'emp_2', department: '', site: '', workplaceId: '', quantity: 1 },
  ];
  assert.equal(singleEmployeeId(allocations), null);
});

test('singleEmployeeId игнорирует не-сотрудника рядом с сотрудником', () => {
  // Смешанная выдача (сотруднику и отделу одновременно) — получатель
  // всё равно один сотрудник, имя печатаем.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 1 },
  ];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});

test('singleEmployeeId схлопывает две записи одного сотрудника в одно значение', () => {
  // Не должно возникать в норме (mergeAllocation сливает такие записи),
  // но функция не должна принять задвоенную запись за двух получателей.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 },
  ];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});

test('singleEmployeeId игнорирует гибридную запись (сотрудник + другой получатель одновременно)', () => {
  // Не должно возникать в норме — mergeAllocation и все известные писатели
  // всегда очищают остальные поля получателя — но правило "заполнено
  // ровно одно поле" защищает всю адресацию выдачи (см. matches() выше и
  // getEmployeeAllocation в app.js), и singleEmployeeId обязан держаться
  // того же инварианта, а не своего отдельного, более слабого.
  const allocations = [{ employeeId: 'emp_1', department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 1 }];
  assert.equal(singleEmployeeId(allocations), null);
});
