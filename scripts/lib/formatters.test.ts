import { describe, it, expect } from "vitest";
import {
	deriveEventType,
	escapeLinkLabel,
	escapeMrkdwn,
	eventTypeLabel,
	formatDateRange,
} from "./formatters.js";

function session(event_type: string) {
	return { event_type };
}

// Intl.DateTimeFormat uses U+202F (narrow no-break space) between the time
// and meridiem on Node 18+. Normalize all whitespace runs to a single space
// so assertions read naturally.
function normalize(s: string): string {
	return s.replace(/\s+/g, " ");
}

describe("formatDateRange", () => {
	it("formats EST (winter) date range with weekday and stripped trailing TZ on the start time", () => {
		// Jan 15 2026 is a Thursday. EST is UTC-5.
		// 15:00Z → 10:00 EST, 16:30Z → 11:30 EST.
		const start = new Date("2026-01-15T15:00:00Z");
		const end = new Date("2026-01-15T16:30:00Z");
		// Note: the start time keeps its meridiem; only the trailing TZ
		// abbreviation is stripped. The end time keeps both.
		expect(normalize(formatDateRange(start, end))).toBe(
			"Thu, Jan 15 · 10:00 AM–11:30 AM EST",
		);
	});

	it("formats EDT (summer) date range across AM/PM boundary", () => {
		// Jul 16 2026 is a Thursday. EDT is UTC-4.
		// 14:00Z → 10:00 AM EDT, 19:30Z → 3:30 PM EDT.
		const start = new Date("2026-07-16T14:00:00Z");
		const end = new Date("2026-07-16T19:30:00Z");
		expect(normalize(formatDateRange(start, end))).toBe(
			"Thu, Jul 16 · 10:00 AM–3:30 PM EDT",
		);
	});

	it("formats midnight crossover times using the start date for the weekday/date", () => {
		// 04:30Z → 11:30 PM EST previous day (Jan 14)
		// 05:30Z → 12:30 AM EST same UTC date but Jan 15 in NY
		const start = new Date("2026-01-15T04:30:00Z");
		const end = new Date("2026-01-15T05:30:00Z");
		expect(normalize(formatDateRange(start, end))).toBe(
			"Wed, Jan 14 · 11:30 PM–12:30 AM EST",
		);
	});
});

describe("escapeMrkdwn", () => {
	it("escapes &, <, and > to their HTML entities", () => {
		expect(escapeMrkdwn("Coffee & Conversation")).toBe("Coffee &amp; Conversation");
		expect(escapeMrkdwn("Meeting <draft>")).toBe("Meeting &lt;draft&gt;");
	});

	it("escapes & first so already-encoded entities are not double-escaped on input", () => {
		expect(escapeMrkdwn("A & <B>")).toBe("A &amp; &lt;B&gt;");
	});

	it("leaves text without special chars unchanged", () => {
		expect(escapeMrkdwn("Plain title 123")).toBe("Plain title 123");
	});

	it("does not touch | (only matters inside link labels)", () => {
		expect(escapeMrkdwn("a|b")).toBe("a|b");
	});
});

describe("escapeLinkLabel", () => {
	it("escapes &, <, > like escapeMrkdwn", () => {
		expect(escapeLinkLabel("Q&A <session>")).toBe("Q&amp;A &lt;session&gt;");
	});

	it("replaces | with the fullwidth bar so it does not terminate the label", () => {
		expect(escapeLinkLabel("Topic | subtopic")).toBe("Topic ｜ subtopic");
	});

	it("handles a title combining all special chars", () => {
		expect(escapeLinkLabel("A & B | <C>")).toBe("A &amp; B ｜ &lt;C&gt;");
	});
});

describe("eventTypeLabel", () => {
	it("returns the in-person label for both spellings", () => {
		expect(eventTypeLabel("in_person")).toBe("🏢 In Person");
		expect(eventTypeLabel("in-person")).toBe("🏢 In Person");
	});

	it("returns the virtual label for virtual and online", () => {
		expect(eventTypeLabel("virtual")).toBe("💻 Virtual");
		expect(eventTypeLabel("online")).toBe("💻 Virtual");
	});

	it("returns the hybrid label", () => {
		expect(eventTypeLabel("hybrid")).toBe("🔀 Hybrid");
	});

	it("is case-insensitive on input", () => {
		expect(eventTypeLabel("IN_PERSON")).toBe("🏢 In Person");
		expect(eventTypeLabel("Virtual")).toBe("💻 Virtual");
	});

	it("returns an empty string for unknown, null, or undefined input", () => {
		expect(eventTypeLabel("")).toBe("");
		expect(eventTypeLabel("something-else")).toBe("");
		expect(eventTypeLabel(null)).toBe("");
		expect(eventTypeLabel(undefined)).toBe("");
	});
});

describe("deriveEventType", () => {
	it("returns hybrid when sessions mix in-person and virtual", () => {
		const event = {
			event_type: "in_person",
			event_sessions: [session("in_person"), session("virtual")],
		};
		expect(deriveEventType(event)).toBe("hybrid");
		// And that flows through to the hybrid label.
		expect(eventTypeLabel(deriveEventType(event))).toBe("🔀 Hybrid");
	});

	it("treats online as virtual when detecting a mix", () => {
		const event = {
			event_type: "in_person",
			event_sessions: [session("in-person"), session("online")],
		};
		expect(deriveEventType(event)).toBe("hybrid");
	});

	it("falls back to the event-level type when sessions agree", () => {
		expect(
			deriveEventType({
				event_type: "in_person",
				event_sessions: [session("in_person"), session("in_person")],
			}),
		).toBe("in_person");
		expect(
			deriveEventType({
				event_type: "virtual",
				event_sessions: [session("virtual")],
			}),
		).toBe("virtual");
	});

	it("falls back to the event-level type when sessions lack a type", () => {
		expect(
			deriveEventType({
				event_type: "Virtual",
				event_sessions: [session(""), {}],
			}),
		).toBe("virtual");
	});

	it("handles a missing or empty sessions array", () => {
		expect(deriveEventType({ event_type: "in_person", event_sessions: [] })).toBe(
			"in_person",
		);
		expect(
			deriveEventType({
				event_type: "in_person",
				event_sessions: undefined as unknown as { event_type?: string }[],
			}),
		).toBe("in_person");
	});
});