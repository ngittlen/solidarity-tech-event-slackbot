import "./lib/env.js";
import { WebClient } from "@slack/web-api";
import type { SolidarityEvent } from "./lib/types.js";
import {
	assertSolidarityApiKey,
	fetchAllEvents,
} from "./lib/solidarity-api.js";
import { EXCLUDE_LOCATIONS, EXCLUDE_PHRASES } from "./lib/exclusions.js";
import { filterEventsInWindow } from "./lib/filters.js";
import {
	SHORT_DATE,
	SHORT_WEEKDAY,
	escapeLinkLabel,
	eventTypeLabel,
	formatDateRange,
} from "./lib/formatters.js";
import { computeDigestWindow, nextDigestFire } from "./lib/week.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID ?? "";
const SCOPE_ID = Number(process.env.PREVIEW_SCOPE_ID ?? "");

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function buildMessage(events: SolidarityEvent[], runAt: Date, isWeekly: boolean): string {
	const tomorrowStr = `${SHORT_WEEKDAY.format(runAt)}, ${SHORT_DATE.format(runAt)}`;
	const digestKind = isWeekly ? "weekly digest" : "new-events alert";

	if (events.length === 0) {
		return `*Preview: Scope ${SCOPE_ID} Events*\nNo events in tomorrow's ${digestKind} window for scope ${SCOPE_ID}.`;
	}

	const lines = events.map((e) => {
		const sessions = e.event_sessions
			.map((s) => formatDateRange(new Date(s.start_time), new Date(s.end_time)))
			.join(", ");
		const typeLabel = eventTypeLabel(e.event_type);
		const titleLine = `• <${e.event_page_url}|${escapeLinkLabel(e.title)}>${typeLabel ? `   ${typeLabel}` : ""}`;
		return `${titleLine}\n  ${sessions}`;
	});

	return [
		`*Preview: Scope ${SCOPE_ID} Events* — ${events.length} event(s) going out in tomorrow's ${digestKind} (${tomorrowStr})`,
		`Review before 9 AM ET if any should be moved to the correct chapter or excluded (add the \`slack-exclude\` tag).`,
		``,
		...lines,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	assertSolidarityApiKey();
	if (!SLACK_BOT_TOKEN) {
		console.error("Missing SLACK_BOT_TOKEN");
		process.exit(1);
	}
	if (!REVIEW_CHANNEL_ID) {
		console.error("Missing REVIEW_CHANNEL_ID");
		process.exit(1);
	}
	if (!Number.isInteger(SCOPE_ID) || SCOPE_ID <= 0) {
		console.error("PREVIEW_SCOPE_ID must be a positive integer");
		process.exit(1);
	}

	console.log(`Fetching events for scope ${SCOPE_ID}...`);
	const allEvents = await fetchAllEvents(SCOPE_ID);

	// Anchor the preview window to the next digest firing so reviewers see
	// exactly the events tomorrow's digest will consider.
	const runAt = nextDigestFire();
	const { nowMs, cutoffMs, isWeekly } = computeDigestWindow(runAt);

	const events = filterEventsInWindow(allEvents, {
		cutoffMs,
		now: nowMs,
		excludePhrases: EXCLUDE_PHRASES,
		excludeLocations: EXCLUDE_LOCATIONS,
	});
	console.log(
		`${allEvents.length} total events fetched, ${events.length} in tomorrow's ${isWeekly ? "weekly" : "mid-week"} digest window`,
	);

	const text = buildMessage(events, runAt, isWeekly);
	const slack = new WebClient(SLACK_BOT_TOKEN);

	await slack.chat.postMessage({
		channel: REVIEW_CHANNEL_ID,
		text,
		unfurl_links: false,
		unfurl_media: false,
	});

	console.log(`Posted preview to channel ${REVIEW_CHANNEL_ID}`);
}

main();