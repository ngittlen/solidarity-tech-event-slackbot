// Shapes returned by the solidarity.tech /v1/events endpoint.

export interface EventSession {
	id: number;
	start_time: string; // ISO 8601, e.g. "2026-02-28T11:00:00.000-06:00"
	end_time: string;
	title: string;
	location_name: string | null;
	location_address: string;
	// Per-session type. The event-level event_type is always a single value
	// ("in_person" or "virtual"); a "hybrid" event is one whose sessions mix
	// in-person and virtual. See deriveEventType in formatters.ts.
	event_type: string;
}

export interface SolidarityEvent {
	id: number;
	title: string;
	event_type: string;
	event_sessions: EventSession[];
	event_page_url: string | null;
	tags: string[];
}

export interface SolidarityEventsMeta {
	total_count: number;
	limit: number;
	offset: number;
}

export interface SolidarityEventsResponse {
	data: SolidarityEvent[];
	meta: SolidarityEventsMeta;
}