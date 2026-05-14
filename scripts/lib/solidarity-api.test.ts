import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from "vitest";
import {
	assertSolidarityApiKey,
	fetchAllEvents,
} from "./solidarity-api.js";
import type {
	SolidarityEvent,
	SolidarityEventsResponse,
} from "./types.js";

function makeEvent(id: number): SolidarityEvent {
	return {
		id,
		title: `Event ${id}`,
		event_type: "in_person",
		event_sessions: [],
		event_page_url: `https://example.com/e/${id}`,
		tags: [],
	};
}

function jsonResponse(body: SolidarityEventsResponse, init: { ok?: boolean; status?: number; text?: string } = {}): Response {
	const ok = init.ok ?? true;
	const status = init.status ?? (ok ? 200 : 500);
	return {
		ok,
		status,
		json: async () => body,
		text: async () => init.text ?? JSON.stringify(body),
	} as unknown as Response;
}

describe("fetchAllEvents", () => {
	const ORIGINAL_KEY = process.env.SOLIDARITY_TECH_API_KEY;

	beforeEach(() => {
		process.env.SOLIDARITY_TECH_API_KEY = "test-key";
	});

	afterEach(() => {
		if (ORIGINAL_KEY === undefined) delete process.env.SOLIDARITY_TECH_API_KEY;
		else process.env.SOLIDARITY_TECH_API_KEY = ORIGINAL_KEY;
	});

	it("returns all events from a single page when total_count <= limit", async () => {
		const events = [makeEvent(1), makeEvent(2)];
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					data: events,
					meta: { total_count: 2, limit: 100, offset: 0 },
				}),
			);

		const result = await fetchAllEvents(123, { fetcher, delayMs: 0 });

		expect(result).toEqual(events);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("paginates with increasing offset until all events are fetched", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => makeEvent(i + 1));
		const page2 = Array.from({ length: 50 }, (_, i) => makeEvent(i + 101));

		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					data: page1,
					meta: { total_count: 150, limit: 100, offset: 0 },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					data: page2,
					meta: { total_count: 150, limit: 100, offset: 100 },
				}),
			);

		const result = await fetchAllEvents(456, { fetcher, delayMs: 0 });

		expect(result).toHaveLength(150);
		expect(fetcher).toHaveBeenCalledTimes(2);

		const url1 = new URL((fetcher.mock.calls[0][0] as string));
		const url2 = new URL((fetcher.mock.calls[1][0] as string));
		expect(url1.searchParams.get("_offset")).toBe("0");
		expect(url2.searchParams.get("_offset")).toBe("100");
	});

	it("sets scope_id, scope_type, and _limit on each request", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				data: [],
				meta: { total_count: 0, limit: 100, offset: 0 },
			}),
		);

		await fetchAllEvents(789, { fetcher, delayMs: 0 });

		const url = new URL(fetcher.mock.calls[0][0] as string);
		expect(url.origin + url.pathname).toBe(
			"https://api.solidarity.tech/v1/events",
		);
		expect(url.searchParams.get("scope_id")).toBe("789");
		expect(url.searchParams.get("scope_type")).toBe("Chapter");
		expect(url.searchParams.get("_limit")).toBe("100");
	});

	it("sends Bearer token from process.env on each request", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse({
				data: [],
				meta: { total_count: 0, limit: 100, offset: 0 },
			}),
		);

		process.env.SOLIDARITY_TECH_API_KEY = "another-key";
		await fetchAllEvents(1, { fetcher, delayMs: 0 });

		const init = fetcher.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["Authorization"]).toBe(
			"Bearer another-key",
		);
		expect((init.headers as Record<string, string>)["Accept"]).toBe(
			"application/json",
		);
	});

	it("throws an Error including status and response text when response is not ok", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
			jsonResponse(
				{ data: [], meta: { total_count: 0, limit: 100, offset: 0 } },
				{ ok: false, status: 503, text: "Service Unavailable" },
			),
		);

		await expect(fetchAllEvents(1, { fetcher, delayMs: 0 })).rejects.toThrow(
			/503.*Service Unavailable/,
		);
	});

	it("breaks out of the loop when a page returns an empty data array", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					data: [makeEvent(1)],
					// total_count claims more remain, but data is empty next page
					meta: { total_count: 999, limit: 100, offset: 0 },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					data: [],
					meta: { total_count: 999, limit: 100, offset: 1 },
				}),
			);

		const result = await fetchAllEvents(1, { fetcher, delayMs: 0 });

		expect(result.map((e) => e.id)).toEqual([1]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("handles a missing data field as empty", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				meta: { total_count: 0, limit: 100, offset: 0 },
			}),
			text: async () => "",
		} as unknown as Response);

		const result = await fetchAllEvents(1, { fetcher, delayMs: 0 });
		expect(result).toEqual([]);
	});
});

describe("assertSolidarityApiKey", () => {
	const ORIGINAL_KEY = process.env.SOLIDARITY_TECH_API_KEY;
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
		if (ORIGINAL_KEY === undefined) delete process.env.SOLIDARITY_TECH_API_KEY;
		else process.env.SOLIDARITY_TECH_API_KEY = ORIGINAL_KEY;
	});

	it("exits when the key is missing", () => {
		delete process.env.SOLIDARITY_TECH_API_KEY;
		expect(() => assertSolidarityApiKey()).toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith("Missing SOLIDARITY_TECH_API_KEY");
	});

	it("exits when the key is an empty string", () => {
		process.env.SOLIDARITY_TECH_API_KEY = "";
		expect(() => assertSolidarityApiKey()).toThrow("process.exit(1)");
	});

	it("does not exit when the key is set", () => {
		process.env.SOLIDARITY_TECH_API_KEY = "ok";
		expect(() => assertSolidarityApiKey()).not.toThrow();
		expect(exitSpy).not.toHaveBeenCalled();
	});
});