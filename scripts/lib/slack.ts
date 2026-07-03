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

// Matches Slack mrkdwn links: <url> or <url|label>
const URL_PATTERN = /<(https?:\/\/[^|>\s]+)[|>]/g;

// Matches a Slack channel mention: <#C0123456> or <#C0123456|channel-name>.
// Slack rewrites a typed `#channel-name` into this form on send.
const CHANNEL_MENTION_PATTERN = /<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g;

// Parses reviewer thread replies into a channelId → intro-text map. A reply
// contributes an intro to every channel it mentions; the mention tokens are
// stripped and the remaining text (trimmed) becomes the intro. Replies with no
// channel mention, or no text once mentions are removed, are ignored. When the
// same channel is mentioned by multiple replies, the last reply wins so
// reviewers can correct themselves by replying again.
export function parseChannelIntros(replyTexts: string[]): Map<string, string> {
	const intros = new Map<string, string>();
	for (const raw of replyTexts) {
		if (typeof raw !== "string") continue;
		const channelIds = [...raw.matchAll(CHANNEL_MENTION_PATTERN)].map((m) => m[1]);
		if (channelIds.length === 0) continue;
		const introText = raw.replace(CHANNEL_MENTION_PATTERN, "").trim();
		if (!introText) continue;
		for (const id of channelIds) intros.set(id, introText);
	}
	return intros;
}

// Reads the review channel, locates the most recent preview post from `botId`
// since `since`, and returns the reviewer-authored intros from its thread,
// keyed by target channel ID. Human replies only — the bot's own messages in
// the thread are ignored. Returns an empty map when no preview post is found.
export async function fetchChannelIntros(
	slack: WebClient,
	reviewChannelId: string,
	botId: string,
	since: Date,
): Promise<Map<string, string>> {
	const oldest = String(since.getTime() / 1000);

	const result = await slack.conversations.history({
		channel: reviewChannelId,
		oldest,
		limit: 200,
	});
	const messages = (result.messages ?? []) as Record<string, unknown>[];

	// history returns newest-first, so the first match is the latest preview.
	const previewRoot = messages.find(
		(m) =>
			m["bot_id"] === botId &&
			typeof m["text"] === "string" &&
			(m["text"] as string).startsWith(PREVIEW_HEADER_PREFIX),
	);
	if (!previewRoot) return new Map();

	const ts = previewRoot["ts"] as string;
	const replies = await slack.conversations.replies({
		channel: reviewChannelId,
		ts,
		limit: 200,
	});
	const replyMessages = (replies.messages ?? []) as Record<string, unknown>[];

	const texts = replyMessages
		.filter((m) => m["ts"] !== ts && m["bot_id"] !== botId)
		.map((m) => m["text"])
		.filter((t): t is string => typeof t === "string");

	return parseChannelIntros(texts);
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
	const oldest = String(since.getTime() / 1000);

	const allMessages: Record<string, unknown>[] = [];
	let cursor: string | undefined;

	do {
		const result = await slack.conversations.history({
			channel: channelId,
			oldest,
			limit: 200,
			...(cursor ? { cursor } : {}),
		});
		allMessages.push(...((result.messages ?? []) as Record<string, unknown>[]));
		cursor = (result.response_metadata as Record<string, string> | undefined)
			?.next_cursor;
	} while (cursor);

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