import { describe, expect, it } from "vitest";
import { checkWindow, validCheckHours } from "../shared/check-schedule";

const daily = { check_start_hour: 8, check_end_hour: 24 };
describe("daily check window in fixed UTC+8", () => {
  it.each([
    ["2026-10-21T07:59:59.999+08:00", false, "2026-10-21T08:00:00+08:00"],
    ["2026-10-21T08:00:00+08:00", true, "2026-10-21T08:00:00+08:00"],
    ["2026-10-21T23:59:59.999+08:00", true, "2026-10-21T23:59:59.999+08:00"],
    ["2026-10-22T00:00:00+08:00", false, "2026-10-22T08:00:00+08:00"],
    ["2026-11-01T00:00:00+08:00", false, "2026-11-01T08:00:00+08:00"],
  ])("checks the boundary at %s", (input, open, next) => {
    expect(checkWindow(Date.parse(input), daily)).toEqual({
      open,
      opensAt: Date.parse(next),
    });
  });
  it("supports a window crossing midnight and advances the next start across a year", () => {
    const overnight = { check_start_hour: 22, check_end_hour: 6 };
    for (const hour of [22, 23, 0, 5]) {
      const now = Date.parse(
        `2026-12-31T${String(hour).padStart(2, "0")}:00:00+08:00`,
      );
      expect(checkWindow(now, overnight)).toEqual({ open: true, opensAt: now });
    }
    expect(
      checkWindow(Date.parse("2026-12-31T06:00:00+08:00"), overnight),
    ).toEqual({
      open: false,
      opensAt: Date.parse("2026-12-31T22:00:00+08:00"),
    });
    expect(
      checkWindow(Date.parse("2026-12-31T23:00:00+08:00"), {
        check_start_hour: 8,
        check_end_hour: 22,
      }),
    ).toEqual({
      open: false,
      opensAt: Date.parse("2027-01-01T08:00:00+08:00"),
    });
  });
  it("permits a full day with 00:00–24:00", () => {
    for (const hour of [0, 7, 8, 23])
      expect(
        checkWindow(
          Date.parse(`2026-10-21T${String(hour).padStart(2, "0")}:00:00+08:00`),
          { check_start_hour: 0, check_end_hour: 24 },
        ).open,
      ).toBe(true);
  });
  it("accepts only whole hours and rejects ambiguous empty windows", () => {
    for (const [start, end] of [
      [8, 24],
      [0, 24],
      [22, 6],
      [23, 24],
    ])
      expect(validCheckHours(start, end)).toBe(true);
    for (const [start, end] of [
      [8, 8],
      [-1, 24],
      [24, 8],
      [8, 0],
      [8, 25],
      [8.5, 24],
      [8, 24.5],
      ["8", 24],
      [null, 24],
      [NaN, 24],
      [8, undefined],
    ])
      expect(validCheckHours(start, end)).toBe(false);
  });
});
