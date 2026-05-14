// Week + digest-window helpers. All operate on a caller-supplied `now`
// (default: current time) so the preview script can simulate the digest's
// view at its next firing.

export function isMonday(now: Date = new Date()): boolean {
	return now.getDay() === 1;
}

export function getMondayOfCurrentWeek(now: Date = new Date()): Date {
	const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const daysFromMonday = day === 0 ? 6 : day - 1;
	const monday = new Date(now);
	monday.setDate(now.getDate() - daysFromMonday);
	monday.setHours(0, 0, 0, 0);
	return monday;
}

export function getSundayOfCurrentWeek(now: Date = new Date()): Date {
	const monday = getMondayOfCurrentWeek(now);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999);
	return sunday;
}

// The digest workflow's cron is `0 14 * * *` — fires at 14:00 UTC daily.
// Returns the next 14:00 UTC strictly after `now`.
export function nextDigestFire(now: Date = new Date()): Date {
	const fire = new Date(now);
	fire.setUTCHours(14, 0, 0, 0);
	if (fire.getTime() <= now.getTime()) {
		fire.setUTCDate(fire.getUTCDate() + 1);
	}
	return fire;
}

// Returns the (now, cutoff) window the digest will use when it runs at
// `runAt`. Mirrors the logic in post-daily-events.ts so the preview can
// show exactly the events the digest will see.
export function computeDigestWindow(runAt: Date): {
	nowMs: number;
	cutoffMs: number;
	isWeekly: boolean;
} {
	const isWeekly = isMonday(runAt);
	const nowMs = runAt.getTime();
	const cutoffMs = isWeekly
		? nowMs + 7 * 24 * 60 * 60 * 1000
		: getSundayOfCurrentWeek(runAt).getTime();
	return { nowMs, cutoffMs, isWeekly };
}