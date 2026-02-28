import { WebClient } from "@slack/web-api";
import type { Block as SlackBlock, KnownBlock } from "@slack/types";
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOLIDARITY_TECH_API_KEY = process.env.SOLIDARITY_TECH_API_KEY ?? "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const EVENTS_DAYS_AHEAD = Number(process.env.EVENTS_DAYS_AHEAD ?? "7");
const CHAPTER_CHANNEL_MAPPING_RAW = process.env.CHAPTER_CHANNEL_MAPPING ?? "";

interface ChapterMapping {
	chapterId: number;
	channelId: string;
	name: string;
	pageUrl: string;
}

// Actual shape returned by the solidarity.tech /v1/events endpoint
interface EventSession {
	id: number;
	start_time: string; // ISO 8601, e.g. "2026-02-28T11:00:00.000-06:00"
	end_time: string;
	title: string;
	location_name: string | null;
	location_address: string;
}

interface SolidarityEvent {
	id: number;
	title: string;
	event_type: string;
	event_sessions: EventSession[];
	event_page_url: string | null;
	tags: string[];
}

interface SolidarityEventsResponse {
	data: SolidarityEvent[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchAllEvents(chapterId: number): Promise<SolidarityEvent[]> {
	const allEvents: SolidarityEvent[] = [];
	let page = 1;
	const limit = 100;

	while (true) {
		const url = new URL("https://api.solidarity.tech/v1/events");
		url.searchParams.set("scope_id", String(chapterId));
		url.searchParams.set("scope_type", "Chapter");
		url.searchParams.set("_limit", String(limit));
		url.searchParams.set("_page", String(page));

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${SOLIDARITY_TECH_API_KEY}`,
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

		if (events.length < limit) break;
		page++;
	}

	return allEvents;
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

function filterAndSortEvents(
	events: SolidarityEvent[],
	daysAhead: number,
): SolidarityEvent[] {
	const now = Date.now();
	const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;

	return events
		.filter((event) => event.event_page_url && !event.tags.includes("slack-exclude"))
		.map((event) => ({
			...event,
			event_sessions: (event.event_sessions ?? [])
				.filter((s) => {
					const t = new Date(s.start_time).getTime();
					return t >= now && t <= cutoff;
				})
				.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
		}))
		.filter((event) => event.event_sessions.length > 0)
		.sort(
			(a, b) =>
				new Date(a.event_sessions[0].start_time).getTime() -
				new Date(b.event_sessions[0].start_time).getTime(),
		);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SHORT_WEEKDAY = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	timeZone: "America/New_York",
});
const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "America/New_York",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
	timeZone: "America/New_York",
});

function formatDateRange(startDate: Date, endDate: Date): string {
	const weekday = SHORT_WEEKDAY.format(startDate);
	const date = SHORT_DATE.format(startDate);
	const startTime = TIME_FMT.format(startDate);
	const endTime = TIME_FMT.format(endDate);

	const startTimeShort = startTime.replace(/\s+\w+$/, "");
	return `${weekday}, ${date} · ${startTimeShort}–${endTime}`;
}

function formatHeaderDateRange(now: Date, daysAhead: number): string {
	const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
	return `${SHORT_DATE.format(now)} – ${SHORT_DATE.format(end)}`;
}

function eventTypeLabel(eventType: string): string {
	switch (eventType) {
		case "in_person":
		case "in-person":
			return "🏢 In Person";
		case "virtual":
		case "online":
			return "💻 Virtual";
		case "hybrid":
			return "🔀 Hybrid";
		default:
			return "";
	}
}

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

// header + subtitle = 2 blocks; each grouped event = 1 section + 1 divider = 2 blocks,
// minus 1 for the removed trailing divider, minus 1 for a possible overflow notice
// → max 23 events before needing to reserve a block for the overflow notice.
const MAX_GROUPS = 23;

function buildBlocks(
	chapterName: string,
	chapterUrl: string,
	events: SolidarityEvent[],
	daysAhead: number,
): (KnownBlock | SlackBlock)[] {
	const now = new Date();
	const dateRange = formatHeaderDateRange(now, daysAhead);

	const headerBlock = {
		type: "header",
		text: {
			type: "plain_text",
			text: `📅 Upcoming Events — ${chapterName}`,
			emoji: true,
		},
	};

	const subtitleBlock = {
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `Next ${daysAhead} days · ${dateRange} · <${chapterUrl}|All Events>`,
			},
		],
	};

	if (events.length === 0) {
		return [
			headerBlock,
			subtitleBlock,
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `No upcoming events in the next ${daysAhead} days.`,
				},
			},
		];
	}

	const overflow = events.length > MAX_GROUPS ? events.length - MAX_GROUPS : 0;
	const visibleEvents = overflow > 0 ? events.slice(0, MAX_GROUPS) : events;

	const eventBlocks: (KnownBlock | SlackBlock)[] = [];
	for (const event of visibleEvents) {
		const titleText = `*<${event.event_page_url!}|${event.title}>*`;

		const normalizedType = event.event_type?.toLowerCase() ?? "";
		const typeLabel = eventTypeLabel(normalizedType);
		const isVirtual = normalizedType === "virtual" || normalizedType === "online";

		const sessionLines = event.event_sessions.map((session) => {
			const startDate = new Date(session.start_time);
			const endDate = new Date(session.end_time);
			const timeStr = formatDateRange(startDate, endDate);
			const location = session.location_address || session.location_name || undefined;

			let line = `📅 *${timeStr}*`;
			if (location && !isVirtual) line += `   📍 _${location}_`;
			if (typeLabel) line += `   ${typeLabel}`;
			return line;
		});

		const sectionBlock: Record<string, unknown> = {
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${titleText}\n${sessionLines.join("\n")}`,
			},
		};

		eventBlocks.push(sectionBlock as unknown as KnownBlock);
		eventBlocks.push({ type: "divider" });
	}

	// Remove trailing divider
	if (eventBlocks.length > 0 && (eventBlocks[eventBlocks.length - 1] as KnownBlock).type === "divider") {
		eventBlocks.pop();
	}

	if (overflow > 0) {
		eventBlocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `_+${overflow} more event${overflow === 1 ? "" : "s"} later this week not shown._`,
				},
			],
		});
	}

	return [headerBlock, subtitleBlock, ...eventBlocks];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function postChapter(
	slack: WebClient,
	mapping: ChapterMapping,
	daysAhead: number,
): Promise<void> {
	const displayName = mapping.name;
	const pageUrl = mapping.pageUrl;
	console.log(`Fetching events for chapter: ${displayName} (${mapping.chapterId})`);
	const allEvents = await fetchAllEvents(mapping.chapterId);
	const events = filterAndSortEvents(allEvents, daysAhead);
	const totalSessions = events.reduce((sum, e) => sum + e.event_sessions.length, 0);
	console.log(
		`  → ${allEvents.length} total events fetched, ${events.length} event(s) with ${totalSessions} session(s) in window`,
	);

	const blocks = buildBlocks(displayName, pageUrl, events, daysAhead);
	const fallbackText =
		events.length > 0
			? `📅 Upcoming Events — ${displayName}: ${events.length} event(s) in the next ${daysAhead} days.`
			: `📅 Upcoming Events — ${displayName}: No upcoming events in the next ${daysAhead} days.`;

	await slack.chat.postMessage({
		channel: mapping.channelId,
		text: fallbackText,
		blocks,
	});
	console.log(`  → Posted to channel ${mapping.channelId}`);
}

async function main(): Promise<void> {
	if (!SOLIDARITY_TECH_API_KEY) {
		console.error("Missing SOLIDARITY_TECH_API_KEY");
		process.exit(1);
	}
	if (!SLACK_BOT_TOKEN) {
		console.error("Missing SLACK_BOT_TOKEN");
		process.exit(1);
	}
	if (!CHAPTER_CHANNEL_MAPPING_RAW) {
		console.error("Missing CHAPTER_CHANNEL_MAPPING");
		process.exit(1);
	}

	let mappings: ChapterMapping[];
	try {
		mappings = JSON.parse(CHAPTER_CHANNEL_MAPPING_RAW) as ChapterMapping[];
	} catch {
		console.error("CHAPTER_CHANNEL_MAPPING is not valid JSON");
		process.exit(1);
	}

	if (!Array.isArray(mappings) || mappings.length === 0) {
		console.error("CHAPTER_CHANNEL_MAPPING must be a non-empty JSON array");
		process.exit(1);
	}

	const slack = new WebClient(SLACK_BOT_TOKEN);
	let anyFailed = false;

	for (const mapping of mappings) {
		try {
			await postChapter(slack, mapping, EVENTS_DAYS_AHEAD);
		} catch (err) {
			console.error(`Failed to post events for chapter ${mapping.name}:`, err);
			anyFailed = true;
		}
	}

	if (anyFailed) {
		process.exit(1);
	}
}

main();
