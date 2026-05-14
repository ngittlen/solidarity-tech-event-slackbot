import "./env.js";
import type { SolidarityEvent, SolidarityEventsResponse } from "./types.js";

// Rate limit: 60 requests per 30 seconds (2 req/s). We delay 1s between
// requests to stay comfortably within limits.
// See https://www.solidarity.tech/reference/solidarity-tech-api#throttling-rules
export const API_DELAY_MS = 1000;
export const delay = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

function getApiKey(): string {
	return process.env.SOLIDARITY_TECH_API_KEY ?? "";
}

export function assertSolidarityApiKey(): void {
	if (!getApiKey()) {
		console.error("Missing SOLIDARITY_TECH_API_KEY");
		process.exit(1);
	}
}

export interface FetchAllEventsOptions {
	// Inject a fetch implementation (defaults to global fetch).
	fetcher?: typeof fetch;
	// Override the inter-page delay (defaults to API_DELAY_MS).
	delayMs?: number;
}

export async function fetchAllEvents(
	scopeId: number,
	opts: FetchAllEventsOptions = {},
): Promise<SolidarityEvent[]> {
	const fetcher = opts.fetcher ?? fetch;
	const delayMs = opts.delayMs ?? API_DELAY_MS;

	const allEvents: SolidarityEvent[] = [];
	const limit = 100;
	let offset = 0;

	while (true) {
		const url = new URL("https://api.solidarity.tech/v1/events");
		url.searchParams.set("scope_id", String(scopeId));
		url.searchParams.set("scope_type", "Chapter");
		url.searchParams.set("_limit", String(limit));
		url.searchParams.set("_offset", String(offset));

		const response = await fetcher(url.toString(), {
			headers: {
				Authorization: `Bearer ${getApiKey()}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(
				`solidarity.tech API error ${response.status}: ${await response.text()}`,
			);
		}

		const body = (await response.json()) as SolidarityEventsResponse;
		const events = body.data ?? [];
		allEvents.push(...events);

		const totalCount = body.meta?.total_count ?? 0;
		if (allEvents.length >= totalCount || events.length === 0) break;

		offset += events.length;
		await delay(delayMs);
	}

	return allEvents;
}