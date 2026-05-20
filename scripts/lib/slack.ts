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

// Matches Slack mrkdwn links: <url> or <url|label>
const URL_PATTERN = /<(https?:\/\/[^|>\s]+)[|>]/g;

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