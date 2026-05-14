import { describe, it, expect } from "vitest";
import {
	computeDigestWindow,
	getMondayOfCurrentWeek,
	getSundayOfCurrentWeek,
	isMonday,
	nextDigestFire,
} from "./week.js";

// All fixture timestamps are 14:00 UTC — the same moment the digest cron
// fires. At 14:00 UTC the local calendar day matches UTC for any TZ between
// UTC-11 and UTC+9 (covers GH Actions and US/EU dev machines).
const MON = new Date("2026-01-12T14:00:00Z");
const TUE = new Date("2026-01-13T14:00:00Z");
const WED = new Date("2026-01-14T14:00:00Z");
const SAT = new Date("2026-01-17T14:00:00Z");
const SUN = new Date("2026-01-18T14:00:00Z");

const ONE_DAY = 24 * 60 * 60 * 1000;

describe("isMonday", () => {
	it("returns true for a Monday", () => {
		expect(isMonday(MON)).toBe(true);
	});

	it("returns false for every other day", () => {
		expect(isMonday(TUE)).toBe(false);
		expect(isMonday(WED)).toBe(false);
		expect(isMonday(SAT)).toBe(false);
		expect(isMonday(SUN)).toBe(false);
	});
});

describe("getMondayOfCurrentWeek", () => {
	it("returns Monday at 00:00 local for a Monday input", () => {
		const result = getMondayOfCurrentWeek(MON);
		expect(result.getDay()).toBe(1);
		expect(result.getHours()).toBe(0);
		expect(result.getMinutes()).toBe(0);
		expect(result.getSeconds()).toBe(0);
		expect(result.getMilliseconds()).toBe(0);
	});

	it("returns the previous Monday when called on a Sunday", () => {
		const result = getMondayOfCurrentWeek(SUN);
		expect(result.getDay()).toBe(1);
		// Sunday Jan 18 → Monday Jan 12 (6 days earlier)
		const diffDays = Math.round(
			(getMidnightLocal(SUN).getTime() - result.getTime()) / ONE_DAY,
		);
		expect(diffDays).toBe(6);
	});

	it("returns the same week's Monday from mid-week", () => {
		const result = getMondayOfCurrentWeek(WED);
		expect(result.getDay()).toBe(1);
		const diffDays = Math.round(
			(getMidnightLocal(WED).getTime() - result.getTime()) / ONE_DAY,
		);
		expect(diffDays).toBe(2);
	});
});

describe("getSundayOfCurrentWeek", () => {
	it("returns Sunday 23:59:59.999 local for a Monday input", () => {
		const result = getSundayOfCurrentWeek(MON);
		expect(result.getDay()).toBe(0);
		expect(result.getHours()).toBe(23);
		expect(result.getMinutes()).toBe(59);
		expect(result.getSeconds()).toBe(59);
		expect(result.getMilliseconds()).toBe(999);
	});

	it("returns the same calendar day end when called on Sunday", () => {
		const result = getSundayOfCurrentWeek(SUN);
		expect(result.getDay()).toBe(0);
		expect(result.getDate()).toBe(SUN.getDate());
	});

	it("Sunday is always after Monday of the same week", () => {
		const mon = getMondayOfCurrentWeek(WED);
		const sun = getSundayOfCurrentWeek(WED);
		expect(sun.getTime() > mon.getTime()).toBe(true);
		// 6 days + ~23h59m = roughly 7 days
		expect(sun.getTime() - mon.getTime()).toBeLessThan(7 * ONE_DAY);
		expect(sun.getTime() - mon.getTime()).toBeGreaterThan(6 * ONE_DAY);
	});
});

describe("nextDigestFire", () => {
	it("returns today's 14:00 UTC when called earlier in the day", () => {
		const morning = new Date("2026-01-12T01:00:00Z");
		expect(nextDigestFire(morning).toISOString()).toBe("2026-01-12T14:00:00.000Z");
	});

	it("advances to tomorrow when called at exactly 14:00 UTC", () => {
		const exact = new Date("2026-01-12T14:00:00.000Z");
		expect(nextDigestFire(exact).toISOString()).toBe("2026-01-13T14:00:00.000Z");
	});

	it("advances to tomorrow when called after 14:00 UTC", () => {
		const afternoon = new Date("2026-01-12T20:00:00Z");
		expect(nextDigestFire(afternoon).toISOString()).toBe("2026-01-13T14:00:00.000Z");
	});

	it("rolls across month boundaries", () => {
		const lateJan = new Date("2026-01-31T20:00:00Z");
		expect(nextDigestFire(lateJan).toISOString()).toBe("2026-02-01T14:00:00.000Z");
	});

	it("rolls across year boundaries", () => {
		const lateDec = new Date("2025-12-31T20:00:00Z");
		expect(nextDigestFire(lateDec).toISOString()).toBe("2026-01-01T14:00:00.000Z");
	});
});

describe("computeDigestWindow", () => {
	it("returns a rolling 7-day window when runAt is a Monday", () => {
		const { nowMs, cutoffMs, isWeekly } = computeDigestWindow(MON);
		expect(isWeekly).toBe(true);
		expect(nowMs).toBe(MON.getTime());
		expect(cutoffMs - nowMs).toBe(7 * ONE_DAY);
	});

	it("returns end-of-week cutoff when runAt is mid-week", () => {
		const { nowMs, cutoffMs, isWeekly } = computeDigestWindow(WED);
		expect(isWeekly).toBe(false);
		expect(nowMs).toBe(WED.getTime());
		const cutoff = new Date(cutoffMs);
		expect(cutoff.getDay()).toBe(0);
		expect(cutoff.getHours()).toBe(23);
		expect(cutoff.getMinutes()).toBe(59);
	});

	it("returns same-day end-of-week cutoff when runAt is a Sunday", () => {
		const { cutoffMs, isWeekly } = computeDigestWindow(SUN);
		expect(isWeekly).toBe(false);
		const cutoff = new Date(cutoffMs);
		expect(cutoff.getDay()).toBe(0);
		expect(cutoff.getDate()).toBe(SUN.getDate());
		expect(cutoffMs).toBeGreaterThan(SUN.getTime());
	});

	it("the preview's window matches the digest's when anchored to the next fire", () => {
		// Preview at 9 PM ET Sunday (01:00 UTC Mon) should produce the same
		// (nowMs, cutoffMs) as the digest run at 14:00 UTC Mon.
		const previewTime = new Date("2026-01-12T01:00:00Z");
		const previewRunAt = nextDigestFire(previewTime);
		const previewWindow = computeDigestWindow(previewRunAt);

		const digestTime = new Date("2026-01-12T14:00:00Z");
		const digestWindow = computeDigestWindow(digestTime);

		expect(previewWindow).toEqual(digestWindow);
	});
});

function getMidnightLocal(d: Date): Date {
	const m = new Date(d);
	m.setHours(0, 0, 0, 0);
	return m;
}