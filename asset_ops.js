// Складские операции над карточкой техники, вынесенные из app.js ради
// тестируемости: app.js — браузерный скрипт без экспортов, его не
// подключить к node, а именно здесь можно тихо испортить количества —
// задвоить выдачу или потерять её.
//
// Файл подключается в index.html до app.js и не трогает DOM, поэтому
// требуется из node в tests/asset_ops.test.js.

// Выдача адресуется ровно одному получателю: сотруднику, отделу, объекту
// или рабочему месту. Сотрудник из "Бухгалтерии" и сама "Бухгалтерия" —
// РАЗНЫЕ получатели; сотрудник и рабочее место (стол), где он сидит, —
// тоже РАЗНЫЕ, поэтому у каждой записи заполнено ровно одно поле, а
// остальные пустые. Эти же правила зашиты в getEmployeeAllocation /
// getDepartmentAllocation / getSiteAllocation / getWorkplaceAllocation
// в app.js; спутай их — и возврат от сотрудника списал бы количество у
// отдела или у его рабочего места.
function matches(entry, employeeId, department, site, workplaceId) {
  if (employeeId) return entry.employeeId === employeeId && !entry.department && !entry.site && !entry.workplaceId;
  if (department) return !entry.employeeId && !entry.site && !entry.workplaceId && entry.department === department;
  if (site) return !entry.employeeId && !entry.department && !entry.workplaceId && entry.site === site;
  return !entry.employeeId && !entry.department && !entry.site && entry.workplaceId === workplaceId;
}

/**
 * Добавляет выданное количество получателю: увеличивает существующую
 * запись или заводит новую. Список меняется на месте.
 * Возвращает затронутую запись.
 */
function mergeAllocation(allocations, { employeeId = null, department = '', site = '', workplaceId = '', quantity } = {}) {
  // Проверки идут до любых изменений, чтобы отклонённая выдача не
  // оставила список наполовину изменённым.
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError(`Количество к выдаче должно быть целым числом от 1, получено: ${quantity}`);
  }
  if (!employeeId && !department && !site && !workplaceId) {
    throw new TypeError('Не указан получатель выдачи: сотрудник, отдел, объект или рабочее место.');
  }

  const existing = allocations.find((entry) => matches(entry, employeeId, department, site, workplaceId));
  if (existing) {
    existing.quantity += quantity;
    return existing;
  }
  // Незаполненные поля хранятся строго как null у сотрудника и пустая
  // строка у остальных — ровно в этом виде их ждёт сервер и поиск выше.
  const entry = {
    employeeId: employeeId || null,
    department: employeeId ? '' : department,
    site: employeeId || department ? '' : site,
    workplaceId: employeeId || department || site ? '' : workplaceId,
    quantity,
  };
  allocations.push(entry);
  return entry;
}

// Строка, по которой ищется техника. Инвентарный номер, серийник,
// наименование и категория — всё, чем пользователь может её назвать:
// тип обычно лежит в категории, а модель в наименовании, поэтому одного
// поля не хватает.
function assetHaystack(asset) {
  return [asset.name, asset.category, asset.inventoryNumber, asset.serialNumber]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/**
 * Отбирает технику по строке поиска. Слова запроса ищутся все и в любом
 * порядке: «мышь a4tech» находит позицию, у которой тип в категории, а
 * модель в наименовании. Порядок исходного списка сохраняется.
 * Пустой запрос возвращает список целиком.
 */
function searchAssets(assets, query) {
  const words = String(query || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
  if (!words.length) return [...(assets || [])];
  return (assets || []).filter((asset) => {
    const haystack = assetHaystack(asset);
    return words.every((word) => haystack.includes(word));
  });
}

// Момент создания записи движения, зашитый в id вида
// `mov_<timestamp>_<rand>` (см. createId в app.js и _new_movement_id в
// mobile_actions.py — оба используют этот формат для движений). Возвращает
// null, если id не в этом формате.
function movementCreatedAt(movement) {
  const createdAt = Number((String(movement.id || '').match(/^mov_(\d+)_/) || [])[1]);
  return Number.isFinite(createdAt) ? createdAt : null;
}

// Ключ сортировки движений по свежести для списков «новые сверху». У
// выдачи «Выдать сразу» (app.js, resetAssetIssueBlock) дата по умолчанию
// неизвестна — технику часто заводят задним числом. Если в этом случае
// считать её самой старой (как делает formatDate/dateSortKey в app.js
// для дат покупки), свежая выдача проваливается в конец журнала и
// выглядит как «операция не создалась», хотя она есть. Вместо этого для
// записей без даты берём момент создания (movementCreatedAt).
//
// Сентинел для нераспознанного id — Number.MIN_SAFE_INTEGER, а не
// -Infinity: два таких движения в одном сравнении дали бы
// -Infinity - (-Infinity) === NaN, и Array.prototype.sort молча
// перестала бы их упорядочивать — та же ловушка, от которой
// предостерегает комментарий у dateSortKey в app.js.
function movementSortValue(movement) {
  const dateTime = movement.date ? new Date(movement.date).getTime() : NaN;
  if (!Number.isNaN(dateTime)) return dateTime;
  const createdAt = movementCreatedAt(movement);
  return createdAt === null ? Number.MIN_SAFE_INTEGER : createdAt;
}

// Единственный сотрудник, за которым закреплена техника — для этикетки
// (§6 ТЗ): печатаем ФИО, только если получатель однозначен. Несколько
// разных сотрудников или получатель не сотрудник вовсе — печатать
// некого, возвращаем null, и строка ФИО на этикетке не появляется.
function singleEmployeeId(allocations) {
  const employeeIds = (allocations || [])
    .filter((entry) => entry.employeeId && !entry.department && !entry.site && !entry.workplaceId)
    .map((entry) => entry.employeeId);
  const unique = [...new Set(employeeIds)];
  return unique.length === 1 ? unique[0] : null;
}

// Нормализация ФИО для сравнения: убираем разницу в регистре, лишние
// пробелы, дефисы и написание «ё»/«е» и узбекских ў/ғ/қ/ҳ через похожие
// русские буквы — самые частые причины, по которым один и тот же
// человек заводится в базе дважды (§1 ТЗ, «различия в написании ФИО»).
// Тот же приём, что searchAssets использует для техники.
function normalizeFullName(fullName) {
  return String(fullName || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Узбекская кириллица: ў/ғ/қ/ҳ типично набирают похожими русскими
    // буквами при вводе с другой раскладки или другим оператором — та же
    // причина дублей, что и «ё»/«е», просто для другого алфавита.
    .replace(/ў/g, 'у')
    .replace(/ғ/g, 'г')
    .replace(/қ/g, 'к')
    .replace(/ҳ/g, 'х')
    // «Петров-Водкин» ≡ «Петров Водкин» — дефис в составной фамилии
    // тоже расходится в написании.
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Ищет сотрудников с похожим ФИО — для предупреждения о возможном
 * дубле при добавлении нового (§1 ТЗ: предупреждать, не запрещать).
 * «Похожий» — совпадает после нормализации целиком, либо слова более
 * короткого ФИО целиком содержатся в более длинном (напр. без
 * отчества). Из двух общих слов при разных остальных — недостаточно:
 * это, скорее всего, разные люди с общей фамилией или именем, а не
 * разное написание одного. excludeId исключает самого редактируемого
 * сотрудника — иначе он всегда «похож сам на себя».
 */
function findSimilarEmployees(employees, fullName, excludeId = '') {
  const normalized = normalizeFullName(fullName);
  if (!normalized) return [];
  const words = normalized.split(' ').filter(Boolean);
  const wordSet = new Set(words);
  return (employees || []).filter((employee) => {
    if (employee.id === excludeId) return false;
    const otherNormalized = normalizeFullName(employee.fullName);
    if (!otherNormalized) return false;
    if (otherNormalized === normalized) return true;
    const otherWords = otherNormalized.split(' ').filter(Boolean);
    const otherWordSet = new Set(otherWords);
    if (wordSet.size < 2 || otherWordSet.size < 2) return false;
    const overlap = words.filter((w) => otherWordSet.has(w));
    return overlap.length >= Math.min(wordSet.size, otherWordSet.size);
  });
}


// ─── ВЫДАЧИ (ASSIGN-NNNN) ────────────────────────────────────────
// Выдача — единственный источник правды о том, у кого что находится.
// Сотрудник, стол и склад не хранят своих копий: все три показывают
// одну и ту же связь, просто с разных сторон. Всё, что ниже — чистые
// функции без DOM, поэтому проверяются из node.

/**
 * Сколько единиц позиции ещё не вернули. Возврат не удаляет строку, а
 * наращивает returnedQuantity — так история переживает возврат, а
 * закрытая позиция просто перестаёт числиться за получателем.
 */
function activeQuantity(item) {
  return Math.max(0, Number(item?.quantity || 0) - Number(item?.returnedQuantity || 0));
}

/**
 * Кому адресуется позиция в терминах allocations. Выдача знает обоих —
 * человека и стол, — но запись о выдаче обязана назвать одного:
 * getEmployeeAllocation и остальные ищут строку ровно с одним
 * заполненным полем. Выбирает scope: личное закреплено за человеком и
 * уезжает с ним, столовое — за местом и остаётся при смене сотрудника.
 *
 * Ровно та же логика, что в assignment_recipient (server.py) — они
 * обязаны совпадать, иначе экран разойдётся с базой после сохранения.
 */
function assignmentRecipient(assignment, scope) {
  const employeeId = assignment?.employeeId || null;
  const workplaceId = assignment?.workplaceId || '';
  const department = String(assignment?.department || '').trim();
  const site = String(assignment?.site || '').trim();
  if (scope === 'workplace' && workplaceId) return { employeeId: null, department: '', site: '', workplaceId };
  if (employeeId) return { employeeId, department: '', site: '', workplaceId: '' };
  if (department) return { employeeId: null, department, site: '', workplaceId: '' };
  if (site) return { employeeId: null, department: '', site, workplaceId: '' };
  return { employeeId: null, department: '', site: '', workplaceId };
}

/** Момент выдачи в миллисекундах — для порядка, не для показа. */
function assignmentSortValue(assignment) {
  const time = assignment?.issuedAt ? new Date(assignment.issuedAt).getTime() : NaN;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Активные остатки всех выдач в виде asset.allocations:
 * `{ assetId: [запись, ...] }`. Пересчитывается после каждой операции —
 * поэтому у сотрудника, у стола и на складе не может разъехаться:
 * считать нечего, кроме одних и тех же выдач.
 */
function projectAllocations(assignments) {
  const byAsset = {};
  (assignments || []).forEach((assignment) => {
    (assignment?.items || []).forEach((item) => {
      const active = activeQuantity(item);
      if (active <= 0 || !item.assetId) return;
      const recipient = assignmentRecipient(assignment, item.scope || 'personal');
      const bucket = byAsset[item.assetId] || (byAsset[item.assetId] = []);
      const existing = bucket.find((entry) => (
        entry.employeeId === recipient.employeeId
        && entry.department === recipient.department
        && entry.site === recipient.site
        && entry.workplaceId === recipient.workplaceId
      ));
      if (existing) existing.quantity += active;
      else bucket.push(Object.assign({}, recipient, { quantity: active }));
    });
  });
  return byAsset;
}

function collectHoldings(assignments, matches) {
  const holdings = [];
  (assignments || []).forEach((assignment) => {
    (assignment?.items || []).forEach((item) => {
      const quantity = activeQuantity(item);
      if (quantity <= 0) return;
      const scope = item.scope || 'personal';
      if (!matches(assignment, item, assignmentRecipient(assignment, scope))) return;
      holdings.push({ assignment, item, assetId: item.assetId, scope, quantity });
    });
  });
  return holdings;
}

/**
 * Вся техника сотрудника одним списком: и личная, и стоящая на его
 * рабочем месте. Два отдельных списка — ровно то, от чего уходим: для
 * пользователя это одна и та же техника «у Иванова», а разница между
 * личной и столовой важна только при пересадке и увольнении, и её
 * несёт поле scope у каждой позиции.
 */
function holdingsForEmployee(assignments, employeeId, workplaceId) {
  return collectHoldings(assignments, (assignment, item, recipient) => (
    (!!employeeId && recipient.employeeId === employeeId)
    || (!!workplaceId && recipient.workplaceId === workplaceId)
  ));
}

/**
 * Вся техника рабочего места: закреплённая за самим столом плюс личная
 * техника того, кто за ним сидит. Тот же список, что видит сотрудник, —
 * потому что читается та же связь, а не отдельная копия для стола.
 */
function holdingsForWorkplace(assignments, workplaceId) {
  if (!workplaceId) return [];
  return collectHoldings(assignments, (assignment, item, recipient) => (
    recipient.workplaceId === workplaceId || assignment.workplaceId === workplaceId
  ));
}

/**
 * Кто держит технику прямо сейчас — для сообщения «уже выдана» вместо
 * невнятного «доступно: 0». Берётся свежая активная выдача: закрытые в
 * счёт не идут, иначе после возврата и повторной выдачи показывался бы
 * прежний хозяин.
 */
function activeHolder(assignments, assetId) {
  const candidates = collectHoldings(assignments, (assignment, item) => item.assetId === assetId);
  if (!candidates.length) return null;
  candidates.sort((a, b) => assignmentSortValue(b.assignment) - assignmentSortValue(a.assignment));
  return { assignment: candidates[0].assignment, item: candidates[0].item };
}

function matchesReturnTarget(recipient, target) {
  if (target.employeeId) return recipient.employeeId === target.employeeId;
  if (target.workplaceId) return recipient.workplaceId === target.workplaceId;
  if (target.department) return recipient.department === target.department;
  if (target.site) return recipient.site === target.site;
  return true;
}

/**
 * Снимает технику с получателя, закрывая позиции выдачи. Сам объект
 * техники не трогается: удалять строку из справочника нельзя — она
 * участвует в истории (§11 и §17 ТЗ). Количество разносится по
 * выдачам от старых к свежим, чтобы «на руках» оставалась последняя.
 *
 * Возвращает список затронутых выдач. Бросает, если снять просят
 * больше, чем числится, — и в этом случае НИЧЕГО не меняет: проверка
 * идёт до первой записи, иначе отклонённый возврат оставил бы половину
 * позиций закрытыми.
 */
function returnFromAssignments(assignments, { assetId, quantity, date = '', employeeId = '', workplaceId = '', department = '', site = '' } = {}) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError(`Количество к возврату должно быть целым числом от 1, получено: ${quantity}`);
  }
  const target = { employeeId, workplaceId, department, site };
  const candidates = collectHoldings(assignments, (assignment, item, recipient) => (
    item.assetId === assetId && matchesReturnTarget(recipient, target)
  ));
  const available = candidates.reduce((sum, holding) => sum + holding.quantity, 0);
  if (quantity > available) {
    throw new Error(`Нельзя снять ${quantity} шт.: числится ${available} шт.`);
  }

  candidates.sort((a, b) => assignmentSortValue(a.assignment) - assignmentSortValue(b.assignment));
  let remaining = quantity;
  const touched = [];
  for (const holding of candidates) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, holding.quantity);
    holding.item.returnedQuantity = Number(holding.item.returnedQuantity || 0) + taken;
    remaining -= taken;
    if (activeQuantity(holding.item) <= 0) holding.item.returnedAt = date;
    if (!touched.includes(holding.assignment)) touched.push(holding.assignment);
  }
  touched.forEach((assignment) => syncAssignmentStatus(assignment, date));
  return touched;
}

/**
 * Статус выдачи — не самостоятельное поле, а следствие её позиций:
 * закрыта ровно тогда, когда вернули всё. Держать его отдельно значило
 * бы завести второй источник правды о той же выдаче. Ту же величину
 * пересчитывает import_state, поэтому клиент и сервер не разойдутся.
 */
function syncAssignmentStatus(assignment, date = '') {
  const items = assignment?.items || [];
  const closed = items.length > 0 && items.every((item) => activeQuantity(item) <= 0);
  assignment.status = closed ? 'returned' : 'active';
  if (closed) {
    const dates = items.map((item) => item.returnedAt).filter(Boolean);
    assignment.returnedAt = dates.length ? dates.sort().slice(-1)[0] : (date || null);
  } else {
    assignment.returnedAt = null;
  }
  return assignment;
}

const AssetOps = {
  mergeAllocation, searchAssets, movementSortValue, movementCreatedAt,
  singleEmployeeId, normalizeFullName, findSimilarEmployees,
  activeQuantity, assignmentRecipient, assignmentSortValue, projectAllocations,
  holdingsForEmployee, holdingsForWorkplace, activeHolder,
  returnFromAssignments, syncAssignmentStatus,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AssetOps;
}
if (typeof window !== 'undefined') {
  window.AssetOps = AssetOps;
}
