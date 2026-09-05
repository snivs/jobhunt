import { describe, expect, it } from "vitest";
import { dueSlot, nextSlot, previousSlot, zonedParts, zonedToDate } from "../src/core/time.js";

const schedule = { timezone: "America/Chihuahua", days: ["monday", "tuesday", "wednesday", "thursday", "friday"] as const, times: ["07:00", "13:00", "19:00"], slot_grace_minutes: 120 };
const sched = { ...schedule, days: [...schedule.days] };

describe("schedule slots in the configured timezone", () => {
  it("converts wall-clock to instants and back", () => {
    const d = zonedToDate({ year: 2026, month: 9, day: 4, hour: 13, minute: 0 }, "America/Chihuahua");
    expect(d.toISOString()).toBe("2026-09-04T19:00:00.000Z");
    const p = zonedParts(d, "America/Chihuahua");
    expect([p.year, p.month, p.day, p.hour, p.minute, p.weekday]).toEqual([2026, 9, 4, 13, 0, "friday"]);
  });

  it("finds previous/next slots and skips weekends", () => {
    const fri1330 = new Date("2026-09-04T19:30:00Z");
    expect(previousSlot(fri1330, sched)?.key).toBe("2026-09-04T13:00");
    expect(nextSlot(fri1330, sched).key).toBe("2026-09-04T19:00");
    const sat = new Date("2026-09-05T15:00:00Z");
    expect(previousSlot(sat, sched)?.key).toBe("2026-09-04T19:00");
    expect(nextSlot(sat, sched).key).toBe("2026-09-07T07:00");
  });

  it("marks a slot due only within the grace window and when not completed", () => {
    const fri1330 = new Date("2026-09-04T19:30:00Z");
    expect(dueSlot(fri1330, sched, null)?.key).toBe("2026-09-04T13:00");
    expect(dueSlot(fri1330, sched, "2026-09-04T13:00")).toBeUndefined();
    const fri1530 = new Date("2026-09-04T21:30:00Z"); // 150 min after 13:00 slot
    expect(dueSlot(fri1530, sched, null)).toBeUndefined();
    const fri1901 = new Date("2026-09-05T01:01:00Z");
    expect(dueSlot(fri1901, sched, "2026-09-04T13:00")?.key).toBe("2026-09-04T19:00");
  });
});
