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

// The solidarity.tech API only ever sets the event-level event_type to a single
// value ("in_person" or "virtual") — it never sends "hybrid". Hybrid-ness lives
// on the sessions: an event is hybrid when its sessions mix in-person and
// virtual. Derive the effective type from the sessions, falling back to the
// event-level value when sessions don't disagree.
export function deriveEventType(event: {
	event_type?: string | null;
	event_sessions: { event_type?: string | null }[];
}): string {
	const sessionTypes = new Set(
		(event.event_sessions ?? [])
			.map((s) => (s.event_type ?? "").toLowerCase())
			.filter(Boolean),
	);
	const hasInPerson = sessionTypes.has("in_person") || sessionTypes.has("in-person");
	const hasVirtual = sessionTypes.has("virtual") || sessionTypes.has("online");
	if (hasInPerson && hasVirtual) return "hybrid";
	return (event.event_type ?? "").toLowerCase();
}

export function eventTypeLabel(eventType: string | null | undefined): string {
	switch ((eventType ?? "").toLowerCase()) {
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