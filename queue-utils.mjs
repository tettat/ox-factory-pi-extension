export function parseScheduledTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isPendingDue(item, now = new Date()) {
  if (!item || item.status !== "pending") return false;
  const scheduled = parseScheduledTime(item.scheduled);
  return !scheduled || scheduled.getTime() <= now.getTime();
}

export function selectNextPending(entries, now = new Date()) {
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];
    if (isPendingDue(item, now)) return { index, item };
  }
  return null;
}

export function nextScheduledIso(minutes, now = new Date()) {
  const delayMs = Math.max(0, Number(minutes) || 0) * 60 * 1000;
  return new Date(now.getTime() + delayMs).toISOString();
}

export function shouldRunInProcess(item = {}) {
  if (item.scheduled || item.repeat) return false;
  return (item.mode || "auto") !== "runner";
}
