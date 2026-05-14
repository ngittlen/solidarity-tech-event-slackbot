import type { SolidarityEvent } from "./types.js";
import { matchesAnyLocation, matchesAnyPhrase } from "./exclusions.js";

export interface FilterEventsOptions {
	cutoffMs: number;
	excludePhrases?: string[];
	excludeLocations?: string[];
	// Override "current time" for deterministic behavior in tests.
	now?: number;
}

// Drops events without a public URL, with the slack-exclude tag, or whose
// title matches an excludePhrases entry. Then drops sessions outside the
// [now, cutoffMs] window or whose location matches excludeLocations.
// Events with no remaining sessions are removed. Sessions within an event
// are sorted by start_time; events are sorted by their earliest session.
export function filterEventsInWindow(
	events: SolidarityEvent[],
	opts: FilterEventsOptions,
): SolidarityEvent[] {
	const now = opts.now ?? Date.now();
	const phrases = opts.excludePhrases ?? [];
	const locations = opts.excludeLocations ?? [];

	return events
		.filter(
			(event) =>
				event.event_page_url &&
				!(event.tags ?? []).includes("slack-exclude") &&
				!matchesAnyPhrase(event.title ?? "", phrases),
		)
		.map((event) => ({
			...event,
			event_sessions: (event.event_sessions ?? [])
				.filter((s) => {
					const t = new Date(s.start_time).getTime();
					if (t < now || t > opts.cutoffMs) return false;
					return !matchesAnyLocation(s, locations);
				})
				.sort(
					(a, b) =>
						new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
				),
		}))
		.filter((event) => event.event_sessions.length > 0)
		.sort(
			(a, b) =>
				new Date(a.event_sessions[0].start_time).getTime() -
				new Date(b.event_sessions[0].start_time).getTime(),
		);
}