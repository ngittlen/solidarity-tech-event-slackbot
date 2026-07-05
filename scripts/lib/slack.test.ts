import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
} from "vitest";
import type { WebClient } from "@slack/web-api";
import {
	INTROS_CLOSED_PREFIX,
	fetchChannelIntros,
	fetchPostedEventUrls,
	getBotId,
	isChannelAccessError,
	parseChannelIntros,
} from "./slack.js";

describe("isChannelAccessError", () => {
	it("returns true for the documented Slack access error codes", () => {
		for (const error of [
			"not_in_channel",
			"channel_not_found",
			"is_archived",
			"missing_scope",
		]) {
			expect(
				isChannelAccessError({ code: "slack_webapi_platform_error", data: { error } }),
			).toBe(true);
		}
	});

	it("returns false for unrelated error codes", () => {
		expect(
			isChannelAccessError({
				code: "slack_webapi_platform_error",
				data: { error: "ratelimited" },
			}),
		).toBe(false);
	});

	it("returns false for non-error values", () => {
		expect(isChannelAccessError(null)).toBe(false);
		expect(isChannelAccessError(undefined)).toBe(false);
		expect(isChannelAccessError("oops")).toBe(false);
		expect(isChannelAccessError(new Error("plain"))).toBe(false);
	});

	it("returns false when data is present but error key is missing", () => {
		expect(isChannelAccessError({ code: "x", data: {} })).toBe(false);
	});
});

describe("getBotId", () => {
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
	});

	it("returns bot_id when auth.test resolves with one", async () => {
		const slack = {
			auth: { test: vi.fn().mockResolvedValue({ bot_id: "B12345" }) },
		} as unknown as WebClient;
		await expect(getBotId(slack)).resolves.toBe("B12345");
	});

	it("exits when auth.test does not return a bot_id", async () => {
		const slack = {
			auth: { test: vi.fn().mockResolvedValue({}) },
		} as unknown as WebClient;
		await expect(getBotId(slack)).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe("fetchPostedEventUrls", () => {
	const BOT_ID = "B12345";
	const SINCE = new Date("2026-01-18T00:00:00Z");

	function mockSlack(
		pages: Array<{
			messages: Array<Record<string, unknown>>;
			next_cursor?: string;
		}>,
	) {
		const history = vi
			.fn()
			.mockImplementation(async ({ cursor }: { cursor?: string }) => {
				const idx = cursor ? Number(cursor) : 0;
				const page = pages[idx];
				return {
					messages: page.messages,
					response_metadata: page.next_cursor
						? { next_cursor: page.next_cursor }
						: undefined,
				};
			});
		const slack = {
			conversations: { history },
		} as unknown as WebClient;
		return { slack, history };
	}

	it("returns an empty set when there are no messages", async () => {
		const { slack } = mockSlack([{ messages: [] }]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(new Set());
	});

	it("extracts URLs from msg.text of bot messages (preview-style posts)", async () => {
		const { slack } = mockSlack([
			{
				messages: [
					{
						bot_id: BOT_ID,
						text: "• <https://example.com/e/1|Event A>\n• <https://example.com/e/2|Event B>",
					},
				],
			},
		]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(
			new Set(["https://example.com/e/1", "https://example.com/e/2"]),
		);
	});

	it("extracts URLs from section blocks (Block Kit digest-style posts)", async () => {
		const { slack } = mockSlack([
			{
				messages: [
					{
						bot_id: BOT_ID,
						text: "fallback",
						blocks: [
							{
								type: "section",
								text: { type: "mrkdwn", text: "*<https://example.com/e/3|Event C>*" },
							},
							{ type: "divider" },
						],
					},
				],
			},
		]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(new Set(["https://example.com/e/3"]));
	});

	it("ignores messages from other bots/users", async () => {
		const { slack } = mockSlack([
			{
				messages: [
					{ bot_id: "OTHER", text: "<https://example.com/e/99|Other>" },
					{ user: "U1", text: "<https://example.com/e/98|Human post>" },
					{ bot_id: BOT_ID, text: "<https://example.com/e/1|Ours>" },
				],
			},
		]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(new Set(["https://example.com/e/1"]));
	});

	it("paginates via response_metadata.next_cursor", async () => {
		const { slack, history } = mockSlack([
			{
				messages: [
					{ bot_id: BOT_ID, text: "<https://example.com/e/1|A>" },
				],
				next_cursor: "1",
			},
			{
				messages: [
					{ bot_id: BOT_ID, text: "<https://example.com/e/2|B>" },
				],
			},
		]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(
			new Set(["https://example.com/e/1", "https://example.com/e/2"]),
		);
		expect(history).toHaveBeenCalledTimes(2);
		expect(history.mock.calls[0][0]).not.toHaveProperty("cursor");
		expect(history.mock.calls[1][0]).toMatchObject({ cursor: "1" });
	});

	it("passes `oldest` as the since timestamp in seconds", async () => {
		const { slack, history } = mockSlack([{ messages: [] }]);
		await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		const expectedOldest = String(SINCE.getTime() / 1000);
		expect(history).toHaveBeenCalledWith(
			expect.objectContaining({ channel: "C1", oldest: expectedOldest, limit: 200 }),
		);
	});

	it("dedupes the same URL appearing in text and blocks", async () => {
		const { slack } = mockSlack([
			{
				messages: [
					{
						bot_id: BOT_ID,
						text: "<https://example.com/e/1|A>",
						blocks: [
							{
								type: "section",
								text: { type: "mrkdwn", text: "<https://example.com/e/1|A again>" },
							},
						],
					},
				],
			},
		]);
		const result = await fetchPostedEventUrls(slack, "C1", BOT_ID, SINCE);
		expect(result).toEqual(new Set(["https://example.com/e/1"]));
	});
});

describe("parseChannelIntros", () => {
	it("maps a channel mention to the remaining trimmed text", () => {
		const result = parseChannelIntros([
			"<#C0123456|chapter-events> Big week ahead, come say hi!",
		]);
		expect(result).toEqual(
			new Map([["C0123456", "Big week ahead, come say hi!"]]),
		);
	});

	it("handles a bare mention with no channel name", () => {
		const result = parseChannelIntros(["<#C0123456> Welcome"]);
		expect(result).toEqual(new Map([["C0123456", "Welcome"]]));
	});

	it("applies one reply to every channel mentioned at the start", () => {
		const result = parseChannelIntros([
			"<#C0000001|a> <#C0000002|b> Shared announcement",
		]);
		expect(result).toEqual(
			new Map([
				["C0000001", "Shared announcement"],
				["C0000002", "Shared announcement"],
			]),
		);
	});

	it("allows commas between leading channel mentions", () => {
		const result = parseChannelIntros([
			"<#C0000001|a>, <#C0000002|b>, <#C0000003|c> Same intro for all three",
		]);
		expect(result).toEqual(
			new Map([
				["C0000001", "Same intro for all three"],
				["C0000002", "Same intro for all three"],
				["C0000003", "Same intro for all three"],
			]),
		);
	});

	it("ignores replies with no channel mention", () => {
		expect(parseChannelIntros(["just a comment, no channel"])).toEqual(
			new Map(),
		);
	});

	it("ignores replies that are only a mention with no intro text", () => {
		expect(parseChannelIntros(["<#C0123456|chapter-events>   "])).toEqual(
			new Map(),
		);
	});

	it("lets a later reply override an earlier one for the same channel", () => {
		const result = parseChannelIntros([
			"<#C0123456|c> first draft",
			"<#C0123456|c> revised intro",
		]);
		expect(result).toEqual(new Map([["C0123456", "revised intro"]]));
	});

	it("ignores replies whose only mention appears mid-text", () => {
		expect(
			parseChannelIntros(["Reminder for <#C0123456|c> tonight"]),
		).toEqual(new Map());
	});

	it("keeps mid-text mentions verbatim in the intro and does not target them", () => {
		const result = parseChannelIntros([
			"<#C0000001|a> Joint social with <#C0000002|b> on Friday",
		]);
		expect(result).toEqual(
			new Map([["C0000001", "Joint social with <#C0000002|b> on Friday"]]),
		);
	});
});

describe("fetchChannelIntros", () => {
	const BOT_ID = "B12345";
	const SINCE = new Date("2026-01-18T00:00:00Z");

	function mockSlack(
		historyMessages: Array<Record<string, unknown>>,
		replyMessages: Array<Record<string, unknown>>,
	) {
		const history = vi.fn().mockResolvedValue({ messages: historyMessages });
		const replies = vi.fn().mockResolvedValue({ messages: replyMessages });
		const slack = {
			conversations: { history, replies },
		} as unknown as WebClient;
		return { slack, history, replies };
	}

	it("returns intros from the latest preview thread, keyed by channel", async () => {
		const { slack, replies } = mockSlack(
			[{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events* — 3 event(s)" }],
			[
				{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events* — 3 event(s)" },
				{ user: "U1", ts: "101.0", text: "<#C0000001|a> Welcome to the chapter" },
			],
		);
		const result = await fetchChannelIntros(slack, "REVIEW", BOT_ID, SINCE);
		expect(result.intros).toEqual(
			new Map([["C0000001", "Welcome to the chapter"]]),
		);
		expect(result.previewTs).toBe("100.0");
		expect(result.closedNoticePosted).toBe(false);
		expect(replies).toHaveBeenCalledWith(
			expect.objectContaining({ channel: "REVIEW", ts: "100.0" }),
		);
	});

	it("returns empty intros and a null previewTs when no preview post is present", async () => {
		const { slack, replies } = mockSlack(
			[{ user: "U1", ts: "50.0", text: "unrelated chatter" }],
			[],
		);
		const result = await fetchChannelIntros(slack, "REVIEW", BOT_ID, SINCE);
		expect(result.intros).toEqual(new Map());
		expect(result.previewTs).toBeNull();
		expect(result.closedNoticePosted).toBe(false);
		expect(replies).not.toHaveBeenCalled();
	});

	it("ignores the root message and the bot's own thread replies", async () => {
		const { slack } = mockSlack(
			[{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events*" }],
			[
				{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events*" },
				{ bot_id: BOT_ID, ts: "102.0", text: "<#C0000009|bot> should be ignored" },
				{ user: "U1", ts: "103.0", text: "<#C0000001|a> real intro" },
			],
		);
		const result = await fetchChannelIntros(slack, "REVIEW", BOT_ID, SINCE);
		expect(result.intros).toEqual(new Map([["C0000001", "real intro"]]));
	});

	it("detects an intros-closed notice already posted by the bot", async () => {
		const { slack } = mockSlack(
			[{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events*" }],
			[
				{ bot_id: BOT_ID, ts: "100.0", text: "*Preview: Scope 1008 Events*" },
				{ user: "U1", ts: "101.0", text: "<#C0000001|a> intro" },
				{
					bot_id: BOT_ID,
					ts: "102.0",
					text: `${INTROS_CLOSED_PREFIX} — the Monday digest is posting now with 1 intro(s).`,
				},
			],
		);
		const result = await fetchChannelIntros(slack, "REVIEW", BOT_ID, SINCE);
		expect(result.closedNoticePosted).toBe(true);
		expect(result.intros).toEqual(new Map([["C0000001", "intro"]]));
	});

	it("passes `oldest` as the since timestamp in seconds", async () => {
		const { slack, history } = mockSlack([], []);
		await fetchChannelIntros(slack, "REVIEW", BOT_ID, SINCE);
		expect(history).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: "REVIEW",
				oldest: String(SINCE.getTime() / 1000),
				limit: 200,
			}),
		);
	});
});