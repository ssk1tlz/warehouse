const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeQuantity,
  projectAllocations,
  holdingsForEmployee,
  holdingsForWorkplace,
  activeHolder,
  returnFromAssignments,
} = require('../asset_ops.js');

// Выдача из четырёх позиций Иванову за столом №7 — пример из ТЗ.
function assignment(overrides = {}) {
  return Object.assign({
    id: 'asg_1',
    code: 'ASSIGN-0001',
    employeeId: 'emp_1',
    workplaceId: '',
    department: '',
    site: '',
    status: 'active',
    issuedAt: '2026-09-10',
    returnedAt: null,
    actNumber: 1,
    items: [item()],
  }, overrides);
}

function item(overrides = {}) {
  return Object.assign({
    id: 'asgi_1',
    assetId: 'a1',
    quantity: 1,
    returnedQuantity: 0,
    scope: 'personal',
    returnedAt: null,
  }, overrides);
}

// ─── активный остаток позиции ────────────────────────────────────

test('активный остаток — выданное минус возвращённое', () => {
  assert.equal(activeQuantity(item({ quantity: 5, returnedQuantity: 2 })), 3);
});

test('полностью возвращённая позиция не держит ничего', () => {
  assert.equal(activeQuantity(item({ quantity: 1, returnedQuantity: 1 })), 0);
});

// ─── проекция в allocations ──────────────────────────────────────

test('личная позиция числится за сотрудником', () => {
  assert.deepEqual(projectAllocations([assignment()]), {
    a1: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 }],
  });
});

test('столовая позиция числится за местом, а не за человеком', () => {
  // Иначе при смене сотрудника монитор уехал бы за ним со стола.
  const source = assignment({ workplaceId: 'wp_7', items: [item({ scope: 'workplace' })] });
  assert.deepEqual(projectAllocations([source]), {
    a1: [{ employeeId: null, department: '', site: '', workplaceId: 'wp_7', quantity: 1 }],
  });
});

test('возвращённая позиция исчезает из проекции целиком', () => {
  const source = assignment({ items: [item({ returnedQuantity: 1 })] });
  assert.deepEqual(projectAllocations([source]), {});
});

test('частичный возврат оставляет в проекции остаток', () => {
  const source = assignment({ items: [item({ quantity: 5, returnedQuantity: 2 })] });
  assert.equal(projectAllocations([source]).a1[0].quantity, 3);
});

test('две выдачи одному сотруднику складываются в одну запись', () => {
  const first = assignment();
  const second = assignment({ id: 'asg_2', items: [item({ id: 'asgi_2', quantity: 2 })] });
  assert.equal(projectAllocations([first, second]).a1.length, 1);
  assert.equal(projectAllocations([first, second]).a1[0].quantity, 3);
});

test('выдача отделу не смешивается с выдачей сотруднику', () => {
  const personal = assignment();
  const departmental = assignment({
    id: 'asg_2', employeeId: null, department: 'Бухгалтерия',
    items: [item({ id: 'asgi_2' })],
  });
  assert.equal(projectAllocations([personal, departmental]).a1.length, 2);
});

// ─── объединённый список сотрудника и стола ──────────────────────

test('сотрудник видит и личную технику, и стоящую на его месте', () => {
  // §8 и §19 ТЗ: один список, а не две независимые коллекции.
  const personal = assignment({ items: [item({ assetId: 'nb' })] });
  const atDesk = assignment({
    id: 'asg_2', employeeId: null, workplaceId: 'wp_7',
    items: [item({ id: 'asgi_2', assetId: 'mon', scope: 'workplace' })],
  });

  const holdings = holdingsForEmployee([personal, atDesk], 'emp_1', 'wp_7');

  assert.deepEqual(holdings.map((h) => h.assetId), ['nb', 'mon']);
  assert.deepEqual(holdings.map((h) => h.scope), ['personal', 'workplace']);
});

test('техника чужого стола в список сотрудника не попадает', () => {
  const other = assignment({
    id: 'asg_2', employeeId: null, workplaceId: 'wp_12',
    items: [item({ assetId: 'mon', scope: 'workplace' })],
  });
  assert.deepEqual(holdingsForEmployee([other], 'emp_1', 'wp_7'), []);
});

test('сотрудник без стола видит только личную технику', () => {
  const personal = assignment({ items: [item({ assetId: 'nb' })] });
  const atDesk = assignment({
    id: 'asg_2', employeeId: null, workplaceId: 'wp_7',
    items: [item({ assetId: 'mon', scope: 'workplace' })],
  });
  assert.deepEqual(holdingsForEmployee([personal, atDesk], 'emp_1', '').map((h) => h.assetId), ['nb']);
});

test('стол показывает ту же технику, что и сидящий за ним сотрудник', () => {
  // §9 и §20 ТЗ: обе карточки читают одну связь, а не свои копии.
  const personal = assignment({ workplaceId: 'wp_7', items: [item({ assetId: 'nb' })] });
  const atDesk = assignment({
    id: 'asg_2', employeeId: null, workplaceId: 'wp_7',
    items: [item({ id: 'asgi_2', assetId: 'mon', scope: 'workplace' })],
  });

  const assignments = [personal, atDesk];
  const desk = holdingsForWorkplace(assignments, 'wp_7').map((h) => h.assetId);
  const employee = holdingsForEmployee(assignments, 'emp_1', 'wp_7').map((h) => h.assetId);

  assert.deepEqual(desk.slice().sort(), employee.slice().sort());
});

test('возвращённая позиция пропадает у сотрудника и у стола разом', () => {
  const source = assignment({ workplaceId: 'wp_7', items: [item({ returnedQuantity: 1 })] });
  assert.deepEqual(holdingsForEmployee([source], 'emp_1', 'wp_7'), []);
  assert.deepEqual(holdingsForWorkplace([source], 'wp_7'), []);
});

// ─── кто держит технику сейчас (§7) ──────────────────────────────

test('активный держатель техники находится по её id', () => {
  const found = activeHolder([assignment()], 'a1');
  assert.equal(found.assignment.code, 'ASSIGN-0001');
  assert.equal(found.item.assetId, 'a1');
});

test('после возврата держателя нет', () => {
  const source = assignment({ items: [item({ returnedQuantity: 1 })] });
  assert.equal(activeHolder([source], 'a1'), null);
});

test('держателем считается свежая выдача, а не закрытая', () => {
  const old = assignment({ status: 'returned', items: [item({ returnedQuantity: 1 })] });
  const current = assignment({
    id: 'asg_2', code: 'ASSIGN-0002', employeeId: 'emp_2',
    items: [item({ id: 'asgi_2' })],
  });
  assert.equal(activeHolder([old, current], 'a1').assignment.code, 'ASSIGN-0002');
});

// ─── снятие позиции с сотрудника (§11) ───────────────────────────

test('снятие позиции закрывает её, а не удаляет технику', () => {
  const assignments = [assignment()];
  const changed = returnFromAssignments(assignments, { assetId: 'a1', quantity: 1, date: '2026-09-12' });

  assert.equal(changed.length, 1, 'изменена одна выдача');
  assert.equal(assignments[0].items.length, 1, 'позиция остаётся в истории');
  assert.equal(assignments[0].items[0].returnedQuantity, 1);
  assert.equal(assignments[0].items[0].returnedAt, '2026-09-12');
  assert.equal(assignments[0].status, 'returned');
});

test('снятие части количества оставляет выдачу активной', () => {
  const assignments = [assignment({ items: [item({ quantity: 5 })] })];
  returnFromAssignments(assignments, { assetId: 'a1', quantity: 2, date: '2026-09-12' });

  assert.equal(assignments[0].items[0].returnedQuantity, 2);
  assert.equal(assignments[0].status, 'active');
});

test('снятие закрывает выдачу только когда вернули все позиции', () => {
  const assignments = [assignment({
    items: [item({ assetId: 'nb' }), item({ id: 'asgi_2', assetId: 'mon' })],
  })];
  returnFromAssignments(assignments, { assetId: 'nb', quantity: 1, date: '2026-09-12' });
  assert.equal(assignments[0].status, 'active');

  returnFromAssignments(assignments, { assetId: 'mon', quantity: 1, date: '2026-09-12' });
  assert.equal(assignments[0].status, 'returned');
});

test('снятие берёт из выдачи выбранного получателя, а не первой попавшейся', () => {
  // Один и тот же монитор может числиться и за отделом, и за человеком.
  const personal = assignment();
  const departmental = assignment({
    id: 'asg_2', employeeId: null, department: 'Бухгалтерия',
    items: [item({ id: 'asgi_2' })],
  });
  returnFromAssignments([personal, departmental], {
    assetId: 'a1', quantity: 1, date: '2026-09-12', employeeId: 'emp_1',
  });

  assert.equal(personal.items[0].returnedQuantity, 1);
  assert.equal(departmental.items[0].returnedQuantity, 0, 'чужая выдача не тронута');
});

test('снятие большего количества, чем числится, не проходит', () => {
  const assignments = [assignment()];
  assert.throws(
    () => returnFromAssignments(assignments, { assetId: 'a1', quantity: 5, date: '2026-09-12' }),
    /числится/,
  );
  assert.equal(assignments[0].items[0].returnedQuantity, 0, 'отклонённый возврат ничего не меняет');
});

test('снятие расходится по нескольким выдачам, начиная со старой', () => {
  const older = assignment({ issuedAt: '2026-09-01' });
  const newer = assignment({ id: 'asg_2', issuedAt: '2026-09-05', items: [item({ id: 'asgi_2', quantity: 2 })] });
  returnFromAssignments([older, newer], { assetId: 'a1', quantity: 2, date: '2026-09-12' });

  assert.equal(older.items[0].returnedQuantity, 1, 'старая выдача закрывается первой');
  assert.equal(newer.items[0].returnedQuantity, 1);
});

// ─── восстановление выдач из старого бэкапа ──────────────────────
// JSON-бэкап, сделанный до слоя выдач, несёт только allocations. Без
// восстановления hydrateState получил бы assignments: [], сервер при
// сохранении пересчитал бы проекцию из пустоты — и вся выданная техника
// обнулилась бы одним нажатием «Импорт».

const { assignmentsFromAllocations } = require('../asset_ops.js');

test('из allocations старого бэкапа восстанавливаются выдачи', () => {
  const assets = [
    { id: 'nb', allocations: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 }] },
    { id: 'mon', allocations: [{ employeeId: null, department: '', site: '', workplaceId: 'wp_7', quantity: 1 }] },
  ];
  const recovered = assignmentsFromAllocations(assets);
  assert.deepEqual(projectAllocations(recovered), {
    nb: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 }],
    mon: [{ employeeId: null, department: '', site: '', workplaceId: 'wp_7', quantity: 1 }],
  });
});

test('позиции одного получателя собираются в одну восстановленную выдачу', () => {
  const assets = [
    { id: 'nb', allocations: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 }] },
    { id: 'kb', allocations: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }] },
  ];
  const recovered = assignmentsFromAllocations(assets);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].items.length, 2);
});

test('восстановленная выдача без даты и с пометкой', () => {
  const recovered = assignmentsFromAllocations([
    { id: 'nb', allocations: [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 }] },
  ]);
  assert.equal(recovered[0].issuedAt, '');
  assert.equal(recovered[0].status, 'active');
  assert.match(recovered[0].notes, /неизвестна/);
});

test('без выданной техники восстанавливать нечего', () => {
  assert.deepEqual(assignmentsFromAllocations([{ id: 'nb', allocations: [] }]), []);
});

// ─── история техники (§10, §14) ──────────────────────────────────

const { assetHistory, heldQuantity } = require('../asset_ops.js');

test('история: выдача и возврат по порядку', () => {
  const source = assignment({ issuedAt: '2026-09-10', items: [item({ returnedQuantity: 1, returnedAt: '2026-09-15' })] });
  const events = assetHistory([source], 'a1');
  assert.deepEqual(events.map((e) => [e.date, e.kind]), [['2026-09-10', 'issue'], ['2026-09-15', 'return']]);
});

test('история: передача другому видна как возврат и новая выдача (§14)', () => {
  const toIvanov = assignment({ issuedAt: '2026-09-10', status: 'returned',
    items: [item({ returnedQuantity: 1, returnedAt: '2026-09-15' })] });
  const toPetrov = assignment({ id: 'asg_2', code: 'ASSIGN-0002', employeeId: 'emp_2', issuedAt: '2026-09-20',
    items: [item({ id: 'asgi_2' })] });
  const events = assetHistory([toPetrov, toIvanov], 'a1');
  assert.deepEqual(
    events.map((e) => [e.kind, e.assignment.employeeId]),
    [['issue', 'emp_1'], ['return', 'emp_1'], ['issue', 'emp_2']],
  );
});

test('история: частичный возврат показывает возвращённое количество', () => {
  const source = assignment({ items: [item({ quantity: 5, returnedQuantity: 2, returnedAt: null })] });
  const back = assetHistory([source], 'a1').find((e) => e.kind === 'return');
  assert.equal(back.quantity, 2);
});

test('история: чужая техника в историю не попадает', () => {
  assert.deepEqual(assetHistory([assignment()], 'другая'), []);
});

// ─── сколько держит конкретный получатель ────────────────────────

test('держит ровно тот получатель, которому адресована позиция', () => {
  const personal = assignment({ workplaceId: 'wp_7', items: [item({ quantity: 2 })] });
  const atDesk = assignment({ id: 'asg_2', employeeId: null, workplaceId: 'wp_7',
    items: [item({ id: 'asgi_2', scope: 'workplace' })] });
  const all = [personal, atDesk];
  assert.equal(heldQuantity(all, 'a1', { employeeId: 'emp_1' }), 2);
  assert.equal(heldQuantity(all, 'a1', { workplaceId: 'wp_7' }), 1, 'столовая — отдельно от личной');
});
