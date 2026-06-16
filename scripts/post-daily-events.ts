import "./lib/env.js";
import { WebClient } from "@slack/web-api";
import type { Block as SlackBlock, KnownBlock } from "@slack/types";
import type { SolidarityEvent } from "./lib/types.js";
import {
	API_DELAY_MS,
	assertSolidarityApiKey,
	delay,
	fetchAllEvents,
} from "./lib/solidarity-api.js";
import { EXCLUDE_LOCATIONS, EXCLUDE_PHRASES } from "./lib/exclusions.js";
import { filterEventsInWindow } from "./lib/filters.js";
import {
	SHORT_DATE,
	deriveEventType,
	escapeLinkLabel,
	eventTypeLabel,
	formatDateRange,
} from "./lib/formatters.js";
import {
	computeDigestWindow,
	getMondayOfCurrentWeek,
	getSundayOfCurrentWeek,
	isMonday,
} from "./lib/week.js";
import {
	fetchPostedEventUrls,
	getBotId,
	isChannelAccessError,
} from "./lib/slack.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHAPTER_CHANNEL_MAPPING_RAW = process.env.CHAPTER_CHANNEL_MAPPING ?? "";

interface ChapterMapping {
	chapterId: number;
	channelId: string;
	name: string;
	pageUrl: string;
}

// ---------------------------------------------------------------------------
// Fetch previously posted event URLs from Slack channel history
// ---------------------------------------------------------------------------

async function hasPostedToday(
	slack: WebClient,
	channelId: string,
	botId: string,
): Promise<boolean> {
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const oldest = String(startOfDay.getTime() / 1000);

	const result = await slack.conversations.history({
		channel: channelId,
		oldest,
		limit: 100,
	});

	const messages = (result.messages ?? []) as Record<string, unknown>[];
	return messages.some((msg) => msg['bot_id'] === botId);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatWeekRange(): string {
	const monday = getMondayOfCurrentWeek();
	const sunday = getSundayOfCurrentWeek();
	return `${SHORT_DATE.format(monday)} – ${SHORT_DATE.format(sunday)}`;
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
	isWeeklyDigest: boolean,
): (KnownBlock | SlackBlock)[] {
	const weekRange = formatWeekRange();

	const headerText = isWeeklyDigest
		? `📅 Upcoming Events — ${chapterName}`
		: `🆕 New Events This Week — ${chapterName}`;

	const subtitleText = isWeeklyDigest
		? `This week · ${weekRange} · <${chapterUrl}|All Events>`
		: `New this week · ${weekRange} · <${chapterUrl}|All Events>`;

	const headerBlock = {
		type: "header",
		text: {
			type: "plain_text",
			text: headerText,
			emoji: true,
		},
	};

	const subtitleBlock = {
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: subtitleText,
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
					text: `No upcoming events this week.`,
				},
			},
		];
	}

	const overflow = events.length > MAX_GROUPS ? events.length - MAX_GROUPS : 0;
	const visibleEvents = overflow > 0 ? events.slice(0, MAX_GROUPS) : events;

	const eventBlocks: (KnownBlock | SlackBlock)[] = [];
	for (const event of visibleEvents) {
		const titleText = `*<${event.event_page_url!}|${escapeLinkLabel(event.title)}>*`;

		const normalizedType = deriveEventType(event);
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
					text: `_+${overflow} more event${overflow === 1 ? "" : "s"} this week not shown._`,
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
	isWeeklyDigest: boolean,
	botId: string,
): Promise<void> {
	const displayName = mapping.name;
	const pageUrl = mapping.pageUrl;

	// On Mondays post 7 days ahead; other days filter to end of the current week.
	const { nowMs, cutoffMs } = computeDigestWindow(new Date());

	if (isWeeklyDigest) {
		let alreadyPosted: boolean;
		try {
			alreadyPosted = await hasPostedToday(slack, mapping.channelId, botId);
		} catch (err) {
			if (isChannelAccessError(err)) {
				console.warn(`  → Cannot read channel ${displayName} (bot not in channel?), skipping`);
				return;
			}
			throw err;
		}
		if (alreadyPosted) {
			console.log(`  → Already posted to ${displayName} today, skipping`);
			return;
		}
	}

	console.log(`Fetching events for chapter: ${displayName}`);
	const allEvents = await fetchAllEvents(mapping.chapterId);
	let events = filterEventsInWindow(allEvents, {
		cutoffMs,
		now: nowMs,
		excludePhrases: EXCLUDE_PHRASES,
		excludeLocations: EXCLUDE_LOCATIONS,
	});
	const totalSessions = events.reduce((sum, e) => sum + e.event_sessions.length, 0);
	console.log(
		`  → ${allEvents.length} total events fetched, ${events.length} event(s) with ${totalSessions} session(s) in window`,
	);

	if (!isWeeklyDigest) {
		// Exclude events whose URLs already appeared in bot messages this week
		let postedUrls: Set<string>;
		try {
			postedUrls = await fetchPostedEventUrls(
				slack,
				mapping.channelId,
				botId,
				getMondayOfCurrentWeek(),
			);
		} catch (err) {
			if (isChannelAccessError(err)) {
				console.warn(`  → Cannot read channel ${displayName} (bot not in channel?), skipping`);
				return;
			}
			throw err;
		}
		console.log(`  → Found ${postedUrls.size} previously posted event URL(s) in channel this week`);
		events = events.filter((e) => !postedUrls.has(e.event_page_url!));
		if (events.length === 0) {
			console.log(`  → No new events to post for ${displayName}, skipping`);
			return;
		}
		console.log(`  → ${events.length} new event(s) not yet posted`);
	}

	const blocks = buildBlocks(displayName, pageUrl, events, isWeeklyDigest);
	const fallbackText =
		events.length > 0
			? `📅 Upcoming Events — ${displayName}: ${events.length} event(s) this week.`
			: `📅 Upcoming Events — ${displayName}: No upcoming events this week.`;

	try {
		await slack.chat.postMessage({
			channel: mapping.channelId,
			text: fallbackText,
			blocks,
			unfurl_links: false,
			unfurl_media: false,
		});
	} catch (err) {
		if (isChannelAccessError(err)) {
			console.warn(`  → Cannot post to channel ${displayName} (bot not in channel?), skipping`);
			return;
		}
		throw err;
	}
	console.log(`  → Posted to channel ${displayName}`);
}

async function main(): Promise<void> {
	assertSolidarityApiKey();
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

	const weeklyDigest = isMonday();
	console.log(`Run mode: ${weeklyDigest ? "weekly digest (Monday)" : "mid-week new events check"}`);
	if (EXCLUDE_PHRASES.length > 0 || EXCLUDE_LOCATIONS.length > 0) {
		console.log(
			`Exclusions: ${EXCLUDE_PHRASES.length} phrase(s), ${EXCLUDE_LOCATIONS.length} location(s)`,
		);
	}

	const slack = new WebClient(SLACK_BOT_TOKEN);
	const botId = await getBotId(slack);

	let anyFailed = false;

	for (const mapping of mappings) {
		try {
			await postChapter(slack, mapping, weeklyDigest, botId);
		} catch (err) {
			console.error(`Failed to post events for chapter ${mapping.name}:`, err);
			anyFailed = true;
		}
		// Use a delay between fetching each chapter to avoid solidarity.tech api rate limits
		await delay(API_DELAY_MS);
	}

	if (anyFailed) {
		process.exit(1);
	}
}

main();