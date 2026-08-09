/** Minimal cron matcher (standard 5-field cron: minute hour dom month dow). */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    fieldMatch(parts[0], date.getMinutes()) &&
    fieldMatch(parts[1], date.getHours()) &&
    fieldMatch(parts[2], date.getDate()) &&
    fieldMatch(parts[3], date.getMonth() + 1) &&
    fieldMatch(parts[4], date.getDay())
  );
}

function fieldMatch(pattern: string, value: number): boolean {
  for (const part of pattern.split(',')) {
    const p = part.trim();
    if (p === '*' || p === '?') return true;
    if (p.startsWith('*/')) {
      const step = Number(p.slice(2));
      if (step > 0 && value % step === 0) return true;
    } else if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      if (value >= a && value <= b) return true;
    } else if (Number(p) === value) {
      return true;
    }
  }
  return false;
}
