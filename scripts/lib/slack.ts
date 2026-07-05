import type { WebClient } from "@slack/web-api";

export const CHANNEL_ACCESS_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"is_archived",
	"missing_scope",
]);

export function isChannelAccessError(err: unknown): boolean {
	if (err && typeof err === "object" && "code" in err) {
		// @slack/web-api wraps API errors with a `data.error` field
		const data = (err as Record<string, unknown>)["data"];
		if (data && typeof data === "object" && "error" in data) {
			return CHANNEL_ACCESS_ERRORS.has(
				String((data as Record<string, unknown>)["error"]),
			);
		}
	}
	return false;
}

export async function getBotId(slack: WebClient): Promise<string> {
	const auth = await slack.auth.test();
	const botId = auth.bot_id;
	if (!botId) {
		console.error(
			"Could not resolve bot_id from auth.test (is SLACK_BOT_TOKEN a bot token?)",
		);
		process.exit(1);
	}
	return botId;
}

// Prefix of the nightly preview post's first line. Shared with
// preview-scope-events.ts so the digest can locate the preview message whose
// thread holds reviewer-authored intros. Both must stay in sync.
export const PREVIEW_HEADER_PREFIX = "*Preview: Scope";

// Slack message-metadata event type attached to every preview post. The
// payload's `weekly` flag distinguishes the Sunday-night weekly preview (whose
// thread collects intros) from mid-week and manually dispatched previews, so
// the digest can't latch onto the wrong thread.
export const PREVIEW_METADATA_EVENT_TYPE = "scope_preview";

// Reads a preview post's metadata: null when the message isn't a
// metadata-tagged preview, otherwise whether it's the weekly one.
function previewMetadata(
	message: Record<string, unknown>,
): { weekly: boolean } | null {
	const metadata = message["metadata"] as
		| { event_type?: unknown; event_payload?: { weekly?: unknown } }
		| undefined;
	if (metadata?.event_type !== PREVIEW_METADATA_EVENT_TYPE) return null;
	return { weekly: metadata.event_payload?.weekly === true };
}

// Matches Slack mrkdwn links: <url> or <url|label>
const URL_PATTERN = /<(https?:\/\/[^|>\s]+)[|>]/g;

// Matches a Slack channel mention: <#C0123456> or <#C0123456|channel-name>.
// Slack rewrites a typed `#channel-name` into this form on send.
const CHANNEL_MENTION_PATTERN = /<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g;

// Matches the run of channel mentions (separated by whitespace/commas) at the
// start of a reply, plus any trailing separators before the intro text.
const LEADING_MENTIONS_PATTERN = /^(?:[\s,]*<#C[A-Z0-9]+(?:\|[^>]*)?>)+[\s,]*/;

// Parses reviewer thread replies into a channelId → intro-text map. The
// channel mentions at the start of a reply are its targets — one or several,
// so the same intro can go to multiple chapters — and everything after them
// (trimmed) becomes the intro. Mentions appearing later in the text are kept
// verbatim as part of the intro, not treated as targets. Replies with no
// leading mention, or no text after the mentions, are ignored. When the same
// channel is targeted by multiple replies, the last reply wins so reviewers
// can correct themselves by replying again.
export function parseChannelIntros(replyTexts: string[]): Map<string, string> {
	const intros = new Map<string, string>();
	for (const raw of replyTexts) {
		if (typeof raw !== "string") continue;
		const leading = raw.match(LEADING_MENTIONS_PATTERN);
		if (!leading) continue;
		const channelIds = [...leading[0].matchAll(CHANNEL_MENTION_PATTERN)].map(
			(m) => m[1],
		);
		const introText = raw.slice(leading[0].length).trim();
		if (!introText) continue;
		for (const id of channelIds) intros.set(id, introText);
	}
	return intros;
}

// Prefix of the bot's "intros are closed" reply in the preview thread. Used
// both to post the notice and to detect that a previous run already posted it
// (so a re-run doesn't repeat it).
export const INTROS_CLOSED_PREFIX = "🔒 *Intros are closed*";

export interface ChannelIntrosResult {
	intros: Map<string, string>;
	// ts of the preview post whose thread was read; null when no preview found.
	previewTs: string | null;
	// True when the bot already posted the intros-closed notice in the thread.
	closedNoticePosted: boolean;
}

// Reads the review channel, locates the most recent preview post from `botId`
// since `since`, and returns the reviewer-authored intros from its thread,
// keyed by target channel ID. Human replies only — the bot's own messages in
// the thread are ignored. Returns empty intros when no preview post is found.
export async function fetchChannelIntros(
	slack: WebClient,
	reviewChannelId: string,
	botId: string,
	since: Date,
): Promise<ChannelIntrosResult> {
	const messages = await fetchHistorySince(slack, reviewChannelId, since);

	// history returns newest-first (pages go back in time), so the first match
	// is the latest weekly preview.
	const isPreviewText = (m: Record<string, unknown>) =>
		typeof m["text"] === "string" &&
		(m["text"] as string).startsWith(PREVIEW_HEADER_PREFIX);
	const previewRoot =
		messages.find((m) => m["bot_id"] === botId && previewMetadata(m)?.weekly) ??
		// Fallback for previews posted before metadata was added: match by header
		// text, but never a message whose metadata marks it a non-weekly preview.
		messages.find(
			(m) => m["bot_id"] === botId && isPreviewText(m) && !previewMetadata(m),
		);
	if (!previewRoot) {
		return { intros: new Map(), previewTs: null, closedNoticePosted: false };
	}

	const ts = previewRoot["ts"] as string;
	const replyMessages: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	do {
		const replies = await slack.conversations.replies({
			channel: reviewChannelId,
			ts,
			limit: 200,
			...(cursor ? { cursor } : {}),
		});
		replyMessages.push(...((replies.messages ?? []) as Record<string, unknown>[]));
		cursor = (replies.response_metadata as Record<string, string> | undefined)
			?.next_cursor;
	} while (cursor);

	const texts = replyMessages
		.filter((m) => m["ts"] !== ts && m["bot_id"] !== botId)
		.map((m) => m["text"])
		.filter((t): t is string => typeof t === "string");

	const closedNoticePosted = replyMessages.some(
		(m) =>
			m["ts"] !== ts &&
			m["bot_id"] === botId &&
			typeof m["text"] === "string" &&
			(m["text"] as string).startsWith(INTROS_CLOSED_PREFIX),
	);

	return { intros: parseChannelIntros(texts), previewTs: ts, closedNoticePosted };
}

// Reads the full channel history since `since`, following pagination cursors.
// Pages are returned newest-first and later pages are older, so the combined
// list stays newest-first. Metadata is included so callers can identify
// metadata-tagged posts (e.g. the weekly preview).
async function fetchHistorySince(
	slack: WebClient,
	channelId: string,
	since: Date,
): Promise<Record<string, unknown>[]> {
	const oldest = String(since.getTime() / 1000);

	const allMessages: Record<string, unknown>[] = [];
	let cursor: string | undefined;

	do {
		const result = await slack.conversations.history({
			channel: channelId,
			oldest,
			limit: 200,
			include_all_metadata: true,
			...(cursor ? { cursor } : {}),
		});
		allMessages.push(...((result.messages ?? []) as Record<string, unknown>[]));
		cursor = (result.response_metadata as Record<string, string> | undefined)
			?.next_cursor;
	} while (cursor);

	return allMessages;
}

// Reads channel history since `since` and returns the set of URLs that have
// already appeared in messages from `botId`. Scans both the plain mrkdwn body
// (`msg.text`, used by preview-style posts) and section blocks (Block Kit
// digest-style posts).
export async function fetchPostedEventUrls(
	slack: WebClient,
	channelId: string,
	botId: string,
	since: Date,
): Promise<Set<string>> {
	const allMessages = await fetchHistorySince(slack, channelId, since);

	const urls = new Set<string>();
	const collectFrom = (text: string) => {
		for (const match of text.matchAll(URL_PATTERN)) urls.add(match[1]);
	};

	for (const msg of allMessages) {
		if (msg["bot_id"] !== botId) continue;

		const text = msg["text"];
		if (typeof text === "string" && text) collectFrom(text);

		const blocks = msg["blocks"];
		if (Array.isArray(blocks)) {
			for (const block of blocks as Record<string, unknown>[]) {
				if (block["type"] === "section") {
					const blockText =
						(block["text"] as Record<string, string> | undefined)?.["text"] ??
						"";
					if (blockText) collectFrom(blockText);
				}
			}
		}
	}

	return urls;
}