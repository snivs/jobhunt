import type { Weekday } from "../config/index.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function daysAgoIso(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

const WEEKDAY_NAMES: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

/** Breaks an instant into wall-clock parts for the given IANA timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekdayIndex = WEEKDAY_NAMES.findIndex((w) => w === (parts.weekday ?? "").toLowerCase());
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_NAMES[weekdayIndex >= 0 ? weekdayIndex : 0]!,
  };
}

/** Offset (ms) of the timezone at the given instant: local wall-clock minus UTC. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts wall-clock parts in a timezone to an instant. */
export function zonedToDate(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const offset1 = tzOffsetMs(new Date(guess), timeZone);
  const candidate = new Date(guess - offset1);
  const offset2 = tzOffsetMs(candidate, timeZone);
  return offset1 === offset2 ? candidate : new Date(guess - offset2);
}

export interface ScheduleLike {
  timezone: string;
  days: Weekday[];
  times: string[];
  slot_grace_minutes: number;
}

export interface ScheduleSlot {
  /** stable identifier, e.g. 2026-09-05T13:00 (wall clock in schedule timezone) */
  key: string;
  at: Date;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function slotsForDay(dayParts: { year: number; month: number; day: number }, schedule: ScheduleLike): ScheduleSlot[] {
  return schedule.times
    .map((t) => {
      const [h, m] = t.split(":").map(Number) as [number, number];
      const at = zonedToDate({ ...dayParts, hour: h, minute: m }, schedule.timezone);
      return { key: `${dayParts.year}-${pad(dayParts.month)}-${pad(dayParts.day)}T${pad(h)}:${pad(m)}`, at };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** All schedule slots within [from - 8 days, from + 8 days], in order. */
function slotsAround(from: Date, schedule: ScheduleLike): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  for (let d = -8; d <= 8; d++) {
    const date = new Date(from.getTime() + d * 86_400_000);
    const p = zonedParts(date, schedule.timezone);
    if (!schedule.days.includes(p.weekday)) continue;
    out.push(...slotsForDay(p, schedule));
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Next slot strictly after `from`. */
export function nextSlot(from: Date, schedule: ScheduleLike): ScheduleSlot {
  const slots = slotsAround(from, schedule);
  const next = slots.find((s) => s.at.getTime() > from.getTime());
  if (!next) throw new Error("No schedule slot found in the next 8 days - check schedule.days/times");
  return next;
}

/** Most recent slot at or before `from`. */
export function previousSlot(from: Date, schedule: ScheduleLike): ScheduleSlot | undefined {
  const slots = slotsAround(from, schedule);
  return [...slots].reverse().find((s) => s.at.getTime() <= from.getTime());
}

/**
 * Determines whether a scheduled run is due now: the most recent slot is within the grace
 * window and has not been completed yet (lastCompletedSlotKey).
 */
export function dueSlot(now: Date, schedule: ScheduleLike, lastCompletedSlotKey: string | null): ScheduleSlot | undefined {
  const prev = previousSlot(now, schedule);
  if (!prev) return undefined;
  if (prev.key === lastCompletedSlotKey) return undefined;
  const ageMinutes = (now.getTime() - prev.at.getTime()) / 60_000;
  if (ageMinutes > schedule.slot_grace_minutes) return undefined;
  return prev;
}

/** Formats an instant as wall-clock text in the given timezone, e.g. "2026-09-05 13:00". */
export function formatZoned(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
