import "./env.js";
import type { EventSession } from "./types.js";

export function parseStringArrayEnv(raw: string, name: string): string[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error(`${name} is not valid JSON`);
		process.exit(1);
	}
	if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
		console.error(`${name} must be a JSON array of strings`);
		process.exit(1);
	}
	return (parsed as string[])
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
}

export function matchesAnyPhrase(title: string, phrases: string[]): boolean {
	if (phrases.length === 0) return false;
	const t = title.toLowerCase();
	return phrases.some((p) => t.includes(p.toLowerCase()));
}

export function matchesAnyLocation(
	session: EventSession,
	locations: string[],
): boolean {
	if (locations.length === 0) return false;
	const loc = `${session.location_name ?? ""} ${session.location_address ?? ""}`.toLowerCase();
	return locations.some((l) => loc.includes(l.toLowerCase()));
}

export const EXCLUDE_PHRASES = parseStringArrayEnv(
	process.env.EXCLUDE_PHRASES ?? "",
	"EXCLUDE_PHRASES",
);
export const EXCLUDE_LOCATIONS = parseStringArrayEnv(
	process.env.EXCLUDE_LOCATIONS ?? "",
	"EXCLUDE_LOCATIONS",
);