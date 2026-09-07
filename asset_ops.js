// Складские операции над карточкой техники, вынесенные из app.js ради
// тестируемости: app.js — браузерный скрипт без экспортов, его не
// подключить к node, а именно здесь можно тихо испортить количества —
// задвоить выдачу или потерять её.
//
// Файл подключается в index.html до app.js и не трогает DOM, поэтому
// требуется из node в tests/asset_ops.test.js.

// Выдача адресуется ровно одному получателю: сотруднику, отделу или
// объекту. Сотрудник из "Бухгалтерии" и сама "Бухгалтерия" — РАЗНЫЕ
// получатели, поэтому у каждой записи заполнено ровно одно поле, а
// остальные пустые. Эти же правила зашиты в getEmployeeAllocation /
// getDepartmentAllocation / getSiteAllocation в app.js; спутай их — и
// возврат от сотрудника списал бы количество у отдела.
function matches(entry, employeeId, department, site) {
  if (employeeId) return entry.employeeId === employeeId && !entry.department && !entry.site;
  if (department) return !entry.employeeId && !entry.site && entry.department === department;
  return !entry.employeeId && !entry.department && entry.site === site;
}

/**
 * Добавляет выданное количество получателю: увеличивает существующую
 * запись или заводит новую. Список меняется на месте.
 * Возвращает затронутую запись.
 */
function mergeAllocation(allocations, { employeeId = null, department = '', site = '', quantity } = {}) {
  // Проверки идут до любых изменений, чтобы отклонённая выдача не
  // оставила список наполовину изменённым.
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError(`Количество к выдаче должно быть целым числом от 1, получено: ${quantity}`);
  }
  if (!employeeId && !department && !site) {
    throw new TypeError('Не указан получатель выдачи: сотрудник, отдел или объект.');
  }

  const existing = allocations.find((entry) => matches(entry, employeeId, department, site));
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
    quantity,
  };
  allocations.push(entry);
  return entry;
}

const AssetOps = { mergeAllocation };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AssetOps;
}
if (typeof window !== 'undefined') {
  window.AssetOps = AssetOps;
}
