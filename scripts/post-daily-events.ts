import "./lib/env.js";
import { WebClient } from "@slack/web-api";
import {
	API_DELAY_MS,
	assertSolidarityApiKey,
	delay,
	fetchAllEvents,
} from "./lib/solidarity-api.js";
import { EXCLUDE_LOCATIONS, EXCLUDE_PHRASES } from "./lib/exclusions.js";
import { filterEventsInWindow } from "./lib/filters.js";
import { MAX_INTRO_LENGTH, buildBlocks } from "./lib/digest.js";
import {
	computeDigestWindow,
	getMondayOfCurrentWeek,
	getMostRecentSundayStart,
	isMonday,
} from "./lib/week.js";
import {
	INTROS_CLOSED_PREFIX,
	fetchChannelIntros,
	fetchPostedEventUrls,
	getBotId,
	isChannelAccessError,
} from "./lib/slack.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHAPTER_CHANNEL_MAPPING_RAW = process.env.CHAPTER_CHANNEL_MAPPING ?? "";
// Optional: the review channel whose preview thread holds reviewer-authored
// intros. When unset, the digest posts without intros (feature off).
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID ?? "";

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
// Main
// ---------------------------------------------------------------------------

async function postChapter(
	slack: WebClient,
	mapping: ChapterMapping,
	isWeeklyDigest: boolean,
	botId: string,
	introText?: string,
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

	// An intro over Slack's section-text limit would fail the whole post with
	// invalid_blocks — degrade to posting without it instead.
	if (introText && introText.length > MAX_INTRO_LENGTH) {
		console.warn(
			`  → Reviewer intro for ${displayName} exceeds ${MAX_INTRO_LENGTH} characters, posting without it`,
		);
		introText = undefined;
	}
	const blocks = buildBlocks(displayName, pageUrl, events, isWeeklyDigest, introText);
	if (introText) {
		console.log(`  → Including reviewer intro for ${displayName}`);
	}
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

	// Intros ride along with the Monday weekly digest only. Pull them from the
	// review channel's latest preview thread; failures here degrade to posting
	// without intros rather than failing the digest.
	let intros = new Map<string, string>();
	if (weeklyDigest && REVIEW_CHANNEL_ID) {
		try {
			const result = await fetchChannelIntros(
				slack,
				REVIEW_CHANNEL_ID,
				botId,
				getMostRecentSundayStart(),
			);
			intros = result.intros;
			console.log(`Loaded ${intros.size} chapter intro(s) from review channel`);

			// Tell reviewers the thread is no longer being read. Skipped when a
			// previous run already said so; failure here shouldn't block the digest.
			if (result.previewTs && !result.closedNoticePosted) {
				await slack.chat.postMessage({
					channel: REVIEW_CHANNEL_ID,
					thread_ts: result.previewTs,
					text:
						`${INTROS_CLOSED_PREFIX} — the Monday digest is posting now with ` +
						`${intros.size} intro(s). Further replies and edits won't be picked up.`,
					unfurl_links: false,
					unfurl_media: false,
				});
				console.log("Posted intros-closed notice to the preview thread");
			}
		} catch (err) {
			console.warn(
				"Could not load intros from review channel, posting without them:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	let anyFailed = false;

	for (const mapping of mappings) {
		try {
			await postChapter(
				slack,
				mapping,
				weeklyDigest,
				botId,
				intros.get(mapping.channelId),
			);
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