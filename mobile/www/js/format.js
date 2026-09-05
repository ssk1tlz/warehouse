const STATUS_LABELS = {
  in_stock: 'На складе',
  assigned: 'Выдано',
  partial: 'Частично выдано',
  repair: 'В ремонте',
  retired: 'Списано',
};

const MOVEMENT_LABELS = {
  purchase: 'Поступление',
  issue: 'Выдача',
  return: 'Возврат',
  repair: 'Ремонт',
  repair_return: 'Возврат из ремонта',
  retire: 'Списание',
  edit: 'Редактирование',
  delete: 'Удаление',
};

// Техника общего пользования (ЮПС, МФУ, принтер на кабинет): одну и ту же
// единицу одновременно держат несколько сотрудников.
function isSharedAsset(asset) {
  return Boolean(asset && asset.isShared);
}

function getAllocatedQuantity(asset) {
  const quantities = (asset.allocations || []).map((a) => Number(a.quantity || 0));
  if (!quantities.length) return 0;
  // У общей позиции держатели делят одни и те же единицы, поэтому занято
  // столько, сколько у самого «крупного» держателя, а не сумма по всем.
  return isSharedAsset(asset) ? Math.max(...quantities) : quantities.reduce((sum, q) => sum + q, 0);
}

// Сколько единиц физически свободно (лежит на складе).
function getAvailableQuantity(asset) {
  return Math.max(0, Number(asset.quantity || 0) - getAllocatedQuantity(asset) - Number(asset.repairQuantity || 0));
}

// Сколько ещё можно выдать конкретному получателю: для обычной позиции это
// свободный остаток, для общей — весь исправный запас за вычетом того, что за
// этим получателем уже числится (другие держатели ему не мешают).
function getIssuableQuantity(asset, holderAllocation) {
  if (!isSharedAsset(asset)) return getAvailableQuantity(asset);
  const capacity = Math.max(0, Number(asset.quantity || 0) - Number(asset.repairQuantity || 0));
  return Math.max(0, capacity - Number((holderAllocation && holderAllocation.quantity) || 0));
}

function getAssetStatus(asset) {
  if (asset.status === 'repair' || asset.status === 'retired') return asset.status;
  const allocated = getAllocatedQuantity(asset);
  const repair = Number(asset.repairQuantity || 0);
  if (asset.quantity <= 0 && Number(asset.retiredQuantity || 0) > 0) return 'retired';
  if (repair > 0 && allocated <= 0 && getAvailableQuantity(asset) <= 0) return 'repair';
  if (allocated <= 0) return 'in_stock';
  if (allocated >= asset.quantity) return 'assigned';
  return 'partial';
}

function holderLabel(allocation, employeesById) {
  if (allocation.employeeId) {
    const employee = employeesById.get(allocation.employeeId);
    return employee ? employee.fullName : 'Неизвестный сотрудник';
  }
  if (allocation.site) return `Объект: ${allocation.site}`;
  return allocation.department ? `Отдел: ${allocation.department}` : 'Неизвестно';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel, getAvailableQuantity, getAllocatedQuantity, getIssuableQuantity, isSharedAsset };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel, getAvailableQuantity, getAllocatedQuantity, getIssuableQuantity, isSharedAsset });
}
