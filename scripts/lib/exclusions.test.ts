import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	matchesAnyLocation,
	matchesAnyPhrase,
	parseStringArrayEnv,
} from "./exclusions.js";
import type { EventSession } from "./types.js";

function makeSession(
	overrides: Partial<EventSession> = {},
): EventSession {
	return {
		id: 1,
		start_time: "2026-01-15T15:00:00Z",
		end_time: "2026-01-15T16:00:00Z",
		title: "Session",
		location_name: null,
		location_address: "",
		event_type: "in_person",
		...overrides,
	};
}

describe("parseStringArrayEnv", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("returns [] for empty / whitespace-only input", () => {
		expect(parseStringArrayEnv("", "X")).toEqual([]);
		expect(parseStringArrayEnv("   ", "X")).toEqual([]);
	});

	it("returns [] for an empty JSON array", () => {
		expect(parseStringArrayEnv("[]", "X")).toEqual([]);
	});

	it("trims, lowercases, and drops empty entries", () => {
		expect(parseStringArrayEnv('["Foo"," BAR ",""," "]', "X")).toEqual([
			"foo",
			"bar",
		]);
	});

	it("preserves duplicates (no dedup expected)", () => {
		expect(parseStringArrayEnv('["a","a","b"]', "X")).toEqual(["a", "a", "b"]);
	});

	it("exits with a useful message on invalid JSON", () => {
		expect(() => parseStringArrayEnv("not json", "MY_VAR")).toThrow(
			"process.exit(1)",
		);
		expect(errorSpy).toHaveBeenCalledWith("MY_VAR is not valid JSON");
	});

	it("exits when JSON is not an array", () => {
		expect(() => parseStringArrayEnv('"a string"', "MY_VAR")).toThrow(
			"process.exit(1)",
		);
		expect(errorSpy).toHaveBeenCalledWith(
			"MY_VAR must be a JSON array of strings",
		);
	});

	it("exits when array contains non-strings", () => {
		expect(() => parseStringArrayEnv("[1, 2]", "MY_VAR")).toThrow(
			"process.exit(1)",
		);
		expect(errorSpy).toHaveBeenCalledWith(
			"MY_VAR must be a JSON array of strings",
		);
	});
});

describe("matchesAnyPhrase", () => {
	it("returns false when phrase list is empty", () => {
		expect(matchesAnyPhrase("Anything", [])).toBe(false);
	});

	it("matches case-insensitive substring", () => {
		expect(matchesAnyPhrase("Monthly Test Event", ["test"])).toBe(true);
		expect(matchesAnyPhrase("Monthly TEST Event", ["test"])).toBe(true);
	});

	it("returns false when no phrase matches", () => {
		expect(matchesAnyPhrase("Member orientation", ["test", "internal"])).toBe(
			false,
		);
	});

	it("returns true if any phrase in the list matches", () => {
		expect(
			matchesAnyPhrase("Internal-only briefing", ["test", "internal"]),
		).toBe(true);
	});
});

describe("matchesAnyLocation", () => {
	it("returns false when location list is empty", () => {
		expect(matchesAnyLocation(makeSession({ location_name: "Anywhere" }), [])).toBe(
			false,
		);
	});

	it("matches against location_name", () => {
		const s = makeSession({ location_name: "Zoom Room A", location_address: "" });
		expect(matchesAnyLocation(s, ["zoom"])).toBe(true);
	});

	it("matches against location_address", () => {
		const s = makeSession({ location_name: null, location_address: "123 HQ Way" });
		expect(matchesAnyLocation(s, ["hq"])).toBe(true);
	});

	it("matches case-insensitively across both fields concatenated", () => {
		const s = makeSession({
			location_name: "Main Office",
			location_address: "555 Detroit Ave",
		});
		expect(matchesAnyLocation(s, ["DETROIT"])).toBe(true);
	});

	it("returns false when neither field contains any entry", () => {
		const s = makeSession({
			location_name: "Library",
			location_address: "100 Elm St",
		});
		expect(matchesAnyLocation(s, ["zoom", "hq"])).toBe(false);
	});

	it("handles null location_name and empty address gracefully", () => {
		const s = makeSession({ location_name: null, location_address: "" });
		expect(matchesAnyLocation(s, ["anything"])).toBe(false);
	});
});