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

function getAllocatedQuantity(asset) {
  return (asset.allocations || []).reduce((sum, a) => sum + Number(a.quantity || 0), 0);
}

function getAvailableQuantity(asset) {
  return Math.max(0, Number(asset.quantity || 0) - getAllocatedQuantity(asset) - Number(asset.repairQuantity || 0));
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
    return employee ? employee.fullName : 'Сотрудник удалён';
  }
  if (allocation.department) return `Отдел «${allocation.department}»`;
  if (allocation.site) return `Объект «${allocation.site}»`;
  return 'Не закреплено';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel, getAvailableQuantity, getAllocatedQuantity };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { getAssetStatus, STATUS_LABELS, MOVEMENT_LABELS, holderLabel, getAvailableQuantity, getAllocatedQuantity });
}
