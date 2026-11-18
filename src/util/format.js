export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatAge(date) {
  const time = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(time)) return '?';
  const diff = Date.now() - time;
  if (diff < 0) return 'now';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h`;
  const days = Math.round(diff / DAY);
  if (days < 45) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function formatDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '?';
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const dd = String(value.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  return value.toISOString();
}

/** `name <email>` → `name`, plus a short email for tables. */
export function shortAuthor(name, email) {
  return name || (email ? email.split('@')[0] : 'unknown');
}

export function pluralizeList(items, limit = 5) {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} +${items.length - limit} more`;
}

export function bytes(size) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(size) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
