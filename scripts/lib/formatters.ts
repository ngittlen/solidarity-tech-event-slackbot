export const SHORT_WEEKDAY = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	timeZone: "America/New_York",
});
export const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "America/New_York",
});
export const TIME_FMT = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
	timeZone: "America/New_York",
});

export function formatDateRange(startDate: Date, endDate: Date): string {
	const weekday = SHORT_WEEKDAY.format(startDate);
	const date = SHORT_DATE.format(startDate);
	const startTime = TIME_FMT.format(startDate);
	const endTime = TIME_FMT.format(endDate);

	const startTimeShort = startTime.replace(/\s+\w+$/, "");
	return `${weekday}, ${date} · ${startTimeShort}–${endTime}`;
}

// Escape characters with special meaning in Slack mrkdwn so user-supplied
// text doesn't break formatting.
// See https://docs.slack.dev/reference/surfaces/formatting/#escaping
export function escapeMrkdwn(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Same as escapeMrkdwn but also replaces `|`, which would otherwise
// terminate the label inside a `<url|label>` link. Slack has no documented
// escape for `|`, so substitute the visually similar fullwidth bar.
export function escapeLinkLabel(text: string): string {
	return escapeMrkdwn(text).replace(/\|/g, "｜");
}