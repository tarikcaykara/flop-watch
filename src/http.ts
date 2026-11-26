// One HTTP request under the collector's transport rules (architecture §5, §11): a 10 s timeout,
// redirects never followed, and the flop-watch User-Agent. A failed request is a measurement, not
// an exception: every failure is classified and returned.

import type { ProbeResult } from "./metrics.ts";
import { USER_AGENT } from "./version.ts";

export const REQUEST_TIMEOUT_MS = 10_000;

/** The outcome of one request: a value, or a classified failure. */
export type HttpOutcome =
	| {
			readonly result: "ok";
			readonly value: unknown;
			readonly ms: number;
			readonly httpStatus: number;
	  }
	| {
			readonly result: Exclude<ProbeResult, "ok">;
			readonly error: string;
			readonly ms: number;
			readonly httpStatus: number | null;
			/** From a Retry-After header, in milliseconds; null when absent or unparsable. */
			readonly retryAfterMs: number | null;
	  };
export type HttpFailure = Exclude<HttpOutcome, { readonly result: "ok" }>;

/** A response that arrived, whatever its status, with its whole body. */
export interface Reply {
	readonly status: number;
	readonly text: string;
	readonly ms: number;
	/** A failure outcome for this response, with its status and Retry-After. */
	readonly fail: (result: HttpFailure["result"], error: string) => HttpFailure;
}

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds from `now`. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
	if (header === null) return null;
	const value = header.trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Sends one request and reads the whole body. Redirects are never followed: a redirect would send
 * the request to an endpoint that is not configured (hard rule 1) and report another host's
 * health, so a 3xx comes back as a reply. A timeout or network failure is returned, never thrown.
 */
export async function send(
	url: string,
	request: { readonly method: "GET" } | { readonly method: "POST"; readonly body: string },
	timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Reply | HttpFailure> {
	const started = performance.now();
	const elapsed = () => performance.now() - started;
	let response: Response;
	let text: string;
	try {
		response = await fetch(url, {
			method: request.method,
			headers: {
				accept: "application/json",
				"user-agent": USER_AGENT,
				...(request.method === "POST" ? { "content-type": "application/json" } : {}),
			},
			body: request.method === "POST" ? request.body : null,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		text = await response.text();
	} catch (err) {
		const cause = err instanceof Error ? err.cause : undefined;
		const timedOut =
			(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) ||
			(typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "UND_ERR_CONNECT_TIMEOUT");
		const detail = cause instanceof Error ? `: ${cause.message}` : "";
		return {
			result: timedOut ? "timeout" : "network_error",
			error: `${err instanceof Error ? err.message : String(err)}${detail}`,
			ms: elapsed(),
			httpStatus: null,
			retryAfterMs: null,
		};
	}

	const ms = elapsed();
	const { status } = response;
	const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
	return {
		status,
		text,
		ms,
		fail: (result, error) => ({ result, error, ms, httpStatus: status, retryAfterMs }),
	};
}

const is2xx = (status: number) => status >= 200 && status < 300;

/** The body as a JSON object, or null when it is not JSON or not an object. */
function jsonObject(text: string): object | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * GETs a JSON object. It is ok when the status is accepted (2xx unless `accept` widens it) and the
 * body is a JSON object. A 429 is rate_limited and any other status http_error. A 2xx whose body is
 * not a JSON object is invalid_response; an accepted non-2xx one is http_error, because the server
 * failed. Error texts carry only the body's `error` string, never the body, which may hold
 * addresses (architecture §11).
 */
export async function getJson(
	url: string,
	options: { accept?: (status: number) => boolean; timeoutMs?: number } = {},
): Promise<HttpOutcome> {
	const reply = await send(url, { method: "GET" }, options.timeoutMs);
	if ("result" in reply) return reply;
	const { status } = reply;
	const body = jsonObject(reply.text);
	if (status === 429) return reply.fail("rate_limited", "HTTP 429");
	if (!(options.accept ?? is2xx)(status)) {
		const detail =
			body !== null && "error" in body && typeof body.error === "string"
				? `: ${body.error.slice(0, 200)}`
				: "";
		return reply.fail("http_error", `HTTP ${status}${detail}`);
	}
	if (body === null) {
		return reply.fail(
			is2xx(status) ? "invalid_response" : "http_error",
			`HTTP ${status}: not a JSON object`,
		);
	}
	return { result: "ok", value: body, ms: reply.ms, httpStatus: status };
}
