// Stub so the dashboard tests load and fail on their assertions (CLAUDE.md › Tests first).

/** A JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function buildDashboard(): { [key: string]: Json } {
	return {};
}
