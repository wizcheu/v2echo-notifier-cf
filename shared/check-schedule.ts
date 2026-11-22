const HOUR = 3600000;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;

export const CHECK_TIME_ZONE = "北京时间 · UTC+8";
export interface CheckSchedule {
  check_start_hour: number;
  check_end_hour: number;
}

export interface CheckIntervals {
  scan_interval_minutes: number;
  following_interval_minutes: number;
  topic_interval_minutes: number;
}

export interface CheckPolicy extends CheckSchedule, CheckIntervals {}

export const CHECK_INTERVAL_OPTIONS = {
  scan: [3, 5, 10, 15],
  following: [5, 10, 15, 30],
  topic: [5, 10, 15, 30, 60],
} as const;

export function validCheckIntervals(scan: unknown, following: unknown, topic: unknown) {
  return (
    typeof scan === "number" &&
    (CHECK_INTERVAL_OPTIONS.scan as readonly number[]).includes(scan) &&
    typeof following === "number" &&
    (CHECK_INTERVAL_OPTIONS.following as readonly number[]).includes(following) &&
    typeof topic === "number" &&
    (CHECK_INTERVAL_OPTIONS.topic as readonly number[]).includes(topic)
  );
}

export function validCheckHours(start: unknown, end: unknown) {
  return (
    typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 0 &&
    start < 24 &&
    typeof end === "number" &&
    Number.isInteger(end) &&
    end >= 1 &&
    end <= 24 &&
    start !== end
  );
}

/** Fixed UTC+8; neither the browser's locale nor the Worker's UTC clock changes the window. */
export function checkWindow(now: number, schedule: CheckSchedule) {
  const local = now + OFFSET;
  const dayStart = Math.floor(local / DAY) * DAY - OFFSET;
  const elapsed = now - dayStart;
  const start = schedule.check_start_hour * HOUR;
  const end = schedule.check_end_hour * HOUR;
  const open =
    start < end
      ? elapsed >= start && elapsed < end
      : elapsed >= start || elapsed < end;
  return {
    open,
    opensAt: open ? now : dayStart + start + (elapsed < start ? 0 : DAY),
  };
}

export const checkHourLabel = (hour: number) =>
  `${String(hour).padStart(2, "0")}:00`;
export const checkScheduleLabel = (schedule: CheckSchedule) =>
  `${checkHourLabel(schedule.check_start_hour)}–${checkHourLabel(schedule.check_end_hour)}${schedule.check_start_hour > schedule.check_end_hour ? "（跨午夜）" : ""}`;
