import { describe, it, expect } from "vitest";
import { filterEventsInWindow } from "./filters.js";
import type { EventSession, SolidarityEvent } from "./types.js";

// Fixed reference time for deterministic windowing.
// 2026-01-15T12:00:00Z
const NOW = Date.parse("2026-01-15T12:00:00Z");
const ONE_DAY = 24 * 60 * 60 * 1000;

function makeSession(overrides: Partial<EventSession> = {}): EventSession {
	return {
		id: 1,
		start_time: new Date(NOW + ONE_DAY).toISOString(),
		end_time: new Date(NOW + ONE_DAY + 60 * 60 * 1000).toISOString(),
		title: "Session",
		location_name: null,
		location_address: "",
		...overrides,
	};
}

function makeEvent(overrides: Partial<SolidarityEvent> = {}): SolidarityEvent {
	return {
		id: 1,
		title: "Sample Event",
		event_type: "in_person",
		event_sessions: [makeSession()],
		event_page_url: "https://example.com/e/1",
		tags: [],
		...overrides,
	};
}

describe("filterEventsInWindow", () => {
	const cutoffMs = NOW + 7 * ONE_DAY;
	const opts = { cutoffMs, now: NOW };

	it("drops events without a public URL", () => {
		const events = [
			makeEvent({ id: 1, event_page_url: null }),
			makeEvent({ id: 2 }),
		];
		const result = filterEventsInWindow(events, opts);
		expect(result.map((e) => e.id)).toEqual([2]);
	});

	it("drops events tagged slack-exclude", () => {
		const events = [
			makeEvent({ id: 1, tags: ["slack-exclude"] }),
			makeEvent({ id: 2, tags: ["other"] }),
		];
		const result = filterEventsInWindow(events, opts);
		expect(result.map((e) => e.id)).toEqual([2]);
	});

	it("drops events whose title matches an excluded phrase (case-insensitive)", () => {
		const events = [
			makeEvent({ id: 1, title: "Test Event" }),
			makeEvent({ id: 2, title: "New Member Orientation" }),
		];
		const result = filterEventsInWindow(events, {
			...opts,
			excludePhrases: ["test"],
		});
		expect(result.map((e) => e.id)).toEqual([2]);
	});

	it("drops sessions whose location matches excludeLocations", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({ id: 10, location_name: "Zoom Room", location_address: "" }),
				makeSession({ id: 11, location_name: "Library", location_address: "100 Elm" }),
			],
		});
		const result = filterEventsInWindow([event], {
			...opts,
			excludeLocations: ["zoom"],
		});
		expect(result).toHaveLength(1);
		expect(result[0].event_sessions.map((s) => s.id)).toEqual([11]);
	});

	it("drops events whose only session was filtered by location", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({ id: 10, location_name: "Zoom Room", location_address: "" }),
			],
		});
		const result = filterEventsInWindow([event], {
			...opts,
			excludeLocations: ["zoom"],
		});
		expect(result).toEqual([]);
	});

	it("drops sessions outside [now, cutoffMs] but keeps the event if any session remains", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				// In the past
				makeSession({
					id: 10,
					start_time: new Date(NOW - ONE_DAY).toISOString(),
					end_time: new Date(NOW - ONE_DAY + 60 * 60 * 1000).toISOString(),
				}),
				// Beyond cutoff
				makeSession({
					id: 11,
					start_time: new Date(cutoffMs + ONE_DAY).toISOString(),
					end_time: new Date(cutoffMs + ONE_DAY + 60 * 60 * 1000).toISOString(),
				}),
				// In window
				makeSession({
					id: 12,
					start_time: new Date(NOW + 2 * ONE_DAY).toISOString(),
					end_time: new Date(NOW + 2 * ONE_DAY + 60 * 60 * 1000).toISOString(),
				}),
			],
		});
		const result = filterEventsInWindow([event], opts);
		expect(result).toHaveLength(1);
		expect(result[0].event_sessions.map((s) => s.id)).toEqual([12]);
	});

	it("treats now and cutoffMs as inclusive boundaries", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({
					id: 10,
					start_time: new Date(NOW).toISOString(),
					end_time: new Date(NOW + 60 * 60 * 1000).toISOString(),
				}),
				makeSession({
					id: 11,
					start_time: new Date(cutoffMs).toISOString(),
					end_time: new Date(cutoffMs + 60 * 60 * 1000).toISOString(),
				}),
			],
		});
		const result = filterEventsInWindow([event], opts);
		expect(result[0].event_sessions.map((s) => s.id)).toEqual([10, 11]);
	});

	it("sorts sessions by start_time within an event", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({
					id: 30,
					start_time: new Date(NOW + 3 * ONE_DAY).toISOString(),
					end_time: new Date(NOW + 3 * ONE_DAY + 3600_000).toISOString(),
				}),
				makeSession({
					id: 10,
					start_time: new Date(NOW + ONE_DAY).toISOString(),
					end_time: new Date(NOW + ONE_DAY + 3600_000).toISOString(),
				}),
				makeSession({
					id: 20,
					start_time: new Date(NOW + 2 * ONE_DAY).toISOString(),
					end_time: new Date(NOW + 2 * ONE_DAY + 3600_000).toISOString(),
				}),
			],
		});
		const result = filterEventsInWindow([event], opts);
		expect(result[0].event_sessions.map((s) => s.id)).toEqual([10, 20, 30]);
	});

	it("sorts events by their earliest session", () => {
		const eventLater = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({
					id: 100,
					start_time: new Date(NOW + 4 * ONE_DAY).toISOString(),
					end_time: new Date(NOW + 4 * ONE_DAY + 3600_000).toISOString(),
				}),
			],
		});
		const eventEarlier = makeEvent({
			id: 2,
			event_sessions: [
				makeSession({
					id: 200,
					start_time: new Date(NOW + ONE_DAY).toISOString(),
					end_time: new Date(NOW + ONE_DAY + 3600_000).toISOString(),
				}),
			],
		});
		const result = filterEventsInWindow([eventLater, eventEarlier], opts);
		expect(result.map((e) => e.id)).toEqual([2, 1]);
	});

	it("handles missing event_sessions array (treats as empty)", () => {
		const event = {
			...makeEvent({ id: 1 }),
			event_sessions: undefined as unknown as EventSession[],
		};
		const result = filterEventsInWindow([event], opts);
		expect(result).toEqual([]);
	});

	it("returns [] when given no events", () => {
		expect(filterEventsInWindow([], opts)).toEqual([]);
	});

	it("does not crash when an event is missing the tags field", () => {
		const event = {
			...makeEvent({ id: 1 }),
			tags: undefined as unknown as string[],
		};
		const result = filterEventsInWindow([event], opts);
		expect(result.map((e) => e.id)).toEqual([1]);
	});

	it("does not crash when an event is missing the title field with phrases set", () => {
		const event = {
			...makeEvent({ id: 1 }),
			title: undefined as unknown as string,
		};
		const result = filterEventsInWindow([event], {
			...opts,
			excludePhrases: ["test"],
		});
		// Missing title can't match any phrase, so the event survives.
		expect(result.map((e) => e.id)).toEqual([1]);
	});

	it("uses Date.now() when opts.now is omitted", () => {
		const event = makeEvent({
			id: 1,
			event_sessions: [
				makeSession({
					id: 10,
					start_time: new Date(Date.now() + ONE_DAY).toISOString(),
					end_time: new Date(Date.now() + ONE_DAY + 3600_000).toISOString(),
				}),
			],
		});
		const result = filterEventsInWindow([event], {
			cutoffMs: Date.now() + 7 * ONE_DAY,
		});
		expect(result).toHaveLength(1);
	});
});