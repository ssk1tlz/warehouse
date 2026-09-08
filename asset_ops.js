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

const AssetOps = { mergeAllocation, searchAssets, movementSortValue, movementCreatedAt, singleEmployeeId };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AssetOps;
}
if (typeof window !== 'undefined') {
  window.AssetOps = AssetOps;
}
