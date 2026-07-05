import { describe, it, expect } from "vitest";
import type { KnownBlock } from "@slack/types";
import type { EventSession, SolidarityEvent } from "./types.js";
import { buildBlocks } from "./digest.js";

let nextId = 1;

function session(overrides: Partial<EventSession> = {}): EventSession {
	return {
		id: nextId++,
		start_time: "2026-07-06T18:00:00.000-04:00",
		end_time: "2026-07-06T19:00:00.000-04:00",
		title: "Session",
		location_name: null,
		location_address: "",
		event_type: "in_person",
		...overrides,
	};
}

function event(
	derivedEventType: string,
	overrides: Partial<SolidarityEvent> = {},
): SolidarityEvent {
	const id = nextId++;
	return {
		id,
		title: `Event ${id}`,
		event_type: derivedEventType === "hybrid" ? "in_person" : derivedEventType,
		event_sessions: [
			session({ event_type: derivedEventType === "virtual" ? "virtual" : "in_person" }),
		],
		event_page_url: `https://example.com/e/${id}`,
		tags: [],
		derivedEventType,
		...overrides,
	};
}

// Flatten the mrkdwn-bearing text of each block, in order, for assertions.
function blockTexts(blocks: ReturnType<typeof buildBlocks>): string[] {
	return (blocks as KnownBlock[]).map((b) => {
		if (b.type === "section") {
			return (b as unknown as { text: { text: string } }).text.text;
		}
		if (b.type === "context") {
			return (b as unknown as { elements: { text: string }[] }).elements[0].text;
		}
		if (b.type === "header") {
			return (b as unknown as { text: { text: string } }).text.text;
		}
		return `<${b.type}>`;
	});
}

describe("buildBlocks", () => {
	it("orders sections in-person, hybrid, virtual regardless of input order", () => {
		const virtual = event("virtual", { title: "Virtual call" });
		const inPerson = event("in_person", { title: "Canvass" });
		const hybrid = event("hybrid", { title: "Hybrid meeting" });

		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [virtual, inPerson, hybrid], true),
		);

		const inPersonHeader = texts.indexOf("🏢 *In Person*");
		const hybridHeader = texts.indexOf("🔀 *Hybrid*");
		const virtualHeader = texts.indexOf("💻 *Virtual*");
		expect(inPersonHeader).toBeGreaterThan(-1);
		expect(hybridHeader).toBeGreaterThan(inPersonHeader);
		expect(virtualHeader).toBeGreaterThan(hybridHeader);

		const canvass = texts.findIndex((t) => t.includes("Canvass"));
		const hybridMeeting = texts.findIndex((t) => t.includes("Hybrid meeting"));
		const virtualCall = texts.findIndex((t) => t.includes("Virtual call"));
		expect(canvass).toBeGreaterThan(inPersonHeader);
		expect(canvass).toBeLessThan(hybridHeader);
		expect(hybridMeeting).toBeGreaterThan(hybridHeader);
		expect(hybridMeeting).toBeLessThan(virtualHeader);
		expect(virtualCall).toBeGreaterThan(virtualHeader);
	});

	it("omits section headers for empty groups", () => {
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [event("in_person")], true),
		);
		expect(texts).toContain("🏢 *In Person*");
		expect(texts).not.toContain("🔀 *Hybrid*");
		expect(texts).not.toContain("💻 *Virtual*");
	});

	it("treats events with unrecognized types as in-person", () => {
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [event("", { title: "Mystery" })], true),
		);
		const header = texts.indexOf("🏢 *In Person*");
		const mystery = texts.findIndex((t) => t.includes("Mystery"));
		expect(header).toBeGreaterThan(-1);
		expect(mystery).toBeGreaterThan(header);
	});

	it("condenses multi-session virtual events to the next session plus a count", () => {
		const virtual = event("virtual", {
			title: "Phonebank",
			event_sessions: [
				session({
					event_type: "virtual",
					start_time: "2026-07-06T18:00:00.000-04:00",
					end_time: "2026-07-06T19:00:00.000-04:00",
				}),
				session({ event_type: "virtual" }),
				session({ event_type: "virtual" }),
			],
		});
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [virtual], true),
		);
		const eventText = texts.find((t) => t.includes("Phonebank"))!;
		expect(eventText).toContain("_+2 more sessions_");
		// Only the next session is listed: one 📅 marker, not three.
		expect(eventText.match(/📅/g)).toHaveLength(1);
		expect(eventText).toContain("Mon, Jul 6");
	});

	it("uses singular wording for one extra virtual session", () => {
		const virtual = event("virtual", {
			event_sessions: [
				session({ event_type: "virtual" }),
				session({ event_type: "virtual" }),
			],
		});
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [virtual], true),
		);
		expect(texts.join("\n")).toContain("_+1 more session_");
	});

	it("still lists every session for multi-session in-person events", () => {
		const inPerson = event("in_person", {
			event_sessions: [
				session({ location_address: "123 Main St" }),
				session({ location_address: "456 Oak Ave" }),
			],
		});
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [inPerson], true),
		);
		const eventText = texts.find((t) => t.includes("example.com/e/"))!;
		expect(eventText.match(/📅/g)).toHaveLength(2);
		expect(eventText).toContain("123 Main St");
		expect(eventText).toContain("456 Oak Ave");
	});

	it("does not include per-event type markers", () => {
		const all = [event("in_person"), event("hybrid"), event("virtual")];
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", all, true),
		);
		const eventTexts = texts.filter((t) => t.includes("example.com/e/"));
		for (const t of eventTexts) {
			expect(t).not.toContain("🏢 In Person");
			expect(t).not.toContain("🔀 Hybrid");
			expect(t).not.toContain("💻 Virtual");
		}
	});

	it("stays within Slack's 50-block limit at maximum overflow", () => {
		const events = [
			...Array.from({ length: 15 }, () => event("in_person")),
			...Array.from({ length: 5 }, () => event("hybrid")),
			...Array.from({ length: 15 }, () => event("virtual")),
		];
		const blocks = buildBlocks(
			"Chapter",
			"https://example.com",
			events,
			true,
			"An intro paragraph",
		);
		expect(blocks.length).toBeLessThanOrEqual(50);
		const texts = blockTexts(blocks);
		expect(texts.some((t) => t.includes("more event"))).toBe(true);
	});

	it("prepends the intro as a section block above the events", () => {
		const texts = blockTexts(
			buildBlocks("Chapter", "https://example.com", [event("in_person")], true, "Big week!"),
		);
		const intro = texts.indexOf("Big week!");
		const header = texts.indexOf("🏢 *In Person*");
		expect(intro).toBeGreaterThan(-1);
		expect(intro).toBeLessThan(header);
	});
});