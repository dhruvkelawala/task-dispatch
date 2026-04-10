export function normalizeNlExpression(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function parseNlExpressionToCron(nlExpression: unknown): string | null {
  const normalized = normalizeNlExpression(nlExpression);
  const map: Record<string, string> = {
    "every morning at 9am": "0 9 * * *",
    "every hour": "0 * * * *",
    "every 2 hours": "0 */2 * * *",
    "every day at midnight": "0 0 * * *",
    "every monday at 10am": "0 10 * * 1",
  };
  return map[normalized] || null;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  if (field === "*") return null;
  const values = new Set<number>();
  const parts = field.split(",").map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (!Number.isInteger(step) || step <= 0) throw new Error("Invalid cron step");
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error("Invalid cron value");
    }
    values.add(value);
  }
  if (values.size === 0) throw new Error("Invalid cron field");
  return values;
}

function normalizeDayOfWeek(day: number): number {
  return day === 7 ? 0 : day;
}

function parseCronExpression(cron: string): {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
} {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must have 5 fields");

  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  const dayOfWeekRaw = parseCronField(fields[4]!, 0, 7);
  const dayOfWeek =
    dayOfWeekRaw === null ? null : new Set(Array.from(dayOfWeekRaw).map(normalizeDayOfWeek));

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function doesDateMatchCron(
  date: Date,
  parsedCron: ReturnType<typeof parseCronExpression>,
): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (parsedCron.minute && !parsedCron.minute.has(minute)) return false;
  if (parsedCron.hour && !parsedCron.hour.has(hour)) return false;
  if (parsedCron.dayOfMonth && !parsedCron.dayOfMonth.has(dayOfMonth)) return false;
  if (parsedCron.month && !parsedCron.month.has(month)) return false;
  if (parsedCron.dayOfWeek && !parsedCron.dayOfWeek.has(dayOfWeek)) return false;
  return true;
}

export function getNextRunAt(cron: string, fromTimestamp = Date.now()): number {
  const parsedCron = parseCronExpression(cron);
  const start = new Date(fromTimestamp);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366;
  for (let i = 0; i < maxIterations; i += 1) {
    if (doesDateMatchCron(start, parsedCron)) return start.getTime();
    start.setMinutes(start.getMinutes() + 1);
  }
  throw new Error("Could not compute next run for cron");
}
