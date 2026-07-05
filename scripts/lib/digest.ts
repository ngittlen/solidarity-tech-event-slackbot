import type { Block as SlackBlock, KnownBlock } from "@slack/types";
import type { SolidarityEvent } from "./types.js";
import {
	EVENT_TYPE_LABELS,
	SHORT_DATE,
	type NormalizedEventType,
	deriveEventType,
	escapeLinkLabel,
	formatDateRange,
	normalizeEventType,
} from "./formatters.js";
import { getMondayOfCurrentWeek, getSundayOfCurrentWeek } from "./week.js";

// header + subtitle = 2 blocks; each grouped event = 1 section + 1 divider = 2 blocks,
// minus 1 for the removed trailing divider, minus 1 for a possible overflow notice
// → max 23 events before needing to reserve a block for the overflow notice.
// The intro block and each section header (up to 3) further lower the budget.
const MAX_EVENTS = 23;

// Slack rejects a section block whose text exceeds 3,000 characters. Callers
// should drop (not truncate) reviewer intros longer than this rather than let
// the whole digest post fail.
export const MAX_INTRO_LENGTH = 3000;

// The digest splits events into sections: in-person at the top, hybrid in the
// middle (only when hybrid events exist), virtual at the bottom. Events with
// no recognizable type are shown with the in-person section.
type EventGroup = NormalizedEventType;
const GROUP_ORDER: EventGroup[] = ["in_person", "hybrid", "virtual"];

// Section header: the shared type emoji with just the label bolded.
function groupHeader(group: EventGroup): string {
	const { emoji, label } = EVENT_TYPE_LABELS[group];
	return `${emoji} *${label}*`;
}

function eventGroup(event: SolidarityEvent): EventGroup {
	return (
		normalizeEventType(event.derivedEventType ?? deriveEventType(event)) ??
		"in_person"
	);
}

function formatWeekRange(): string {
	const monday = getMondayOfCurrentWeek();
	const sunday = getSundayOfCurrentWeek();
	return `${SHORT_DATE.format(monday)} – ${SHORT_DATE.format(sunday)}`;
}

export function buildBlocks(
	chapterName: string,
	chapterUrl: string,
	events: SolidarityEvent[],
	isWeeklyDigest: boolean,
	introText?: string,
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

	// Reviewer-authored intro paragraph, prepended above the events. Left as
	// mrkdwn (not escaped) so reviewers can format it.
	const introBlocks: (KnownBlock | SlackBlock)[] = introText
		? [
				{
					type: "section",
					text: { type: "mrkdwn", text: introText },
				} as unknown as KnownBlock,
			]
		: [];

	if (events.length === 0) {
		return [
			headerBlock,
			subtitleBlock,
			...introBlocks,
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `No upcoming events this week.`,
				},
			},
		];
	}

	// Order events by section: in-person, then hybrid, then virtual. Within a
	// section the upstream soonest-first ordering is preserved.
	const grouped = GROUP_ORDER.map((group) => ({
		group,
		events: events.filter((e) => eventGroup(e) === group),
	})).filter((g) => g.events.length > 0);

	// The intro block and each section header consume a block, so they lower
	// how many events we can show.
	const maxVisibleEvents = MAX_EVENTS - introBlocks.length - grouped.length;
	const ordered = grouped.flatMap(({ group, events: groupEvents }) =>
		groupEvents.map((event) => ({ event, group })),
	);
	const overflow =
		ordered.length > maxVisibleEvents ? ordered.length - maxVisibleEvents : 0;
	const visible = overflow > 0 ? ordered.slice(0, maxVisibleEvents) : ordered;

	const eventBlocks: (KnownBlock | SlackBlock)[] = [];
	let currentGroup: EventGroup | null = null;
	for (const { event, group } of visible) {
		if (group !== currentGroup) {
			eventBlocks.push({
				type: "context",
				elements: [{ type: "mrkdwn", text: groupHeader(group) }],
			});
			currentGroup = group;
		}

		const titleText = `*<${event.event_page_url!}|${escapeLinkLabel(event.title)}>*`;
		const sessions = event.event_sessions;
		const isVirtual = group === "virtual";

		let sessionLines: string[];
		if (isVirtual && sessions.length > 1) {
			// Condense recurring virtual events: show the next session (sessions
			// are sorted soonest-first) and how many more are in the window.
			const next = sessions[0];
			const timeStr = formatDateRange(
				new Date(next.start_time),
				new Date(next.end_time),
			);
			const more = sessions.length - 1;
			sessionLines = [
				`📅 *${timeStr}*   _+${more} more session${more === 1 ? "" : "s"}_`,
			];
		} else {
			sessionLines = sessions.map((session) => {
				const startDate = new Date(session.start_time);
				const endDate = new Date(session.end_time);
				const timeStr = formatDateRange(startDate, endDate);
				const location = session.location_address || session.location_name || undefined;

				let line = `📅 *${timeStr}*`;
				if (location && !isVirtual) line += `   📍 _${location}_`;
				return line;
			});
		}

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

	return [headerBlock, subtitleBlock, ...introBlocks, ...eventBlocks];
}