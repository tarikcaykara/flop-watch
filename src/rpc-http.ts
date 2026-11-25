// JSON-RPC 2.0 over HTTP, behind the read-only method allowlist (architecture §11, hard rule 2).
// A failed call is a measurement, not an exception: rpcCall classifies it and returns.

import type { ProbeResult } from "./metrics.ts";
import { USER_AGENT } from "./version.ts";

export const REQUEST_TIMEOUT_MS = 10_000;

/** Every JSON-RPC method flop-watch may call, over HTTP or WebSocket. All are reads. */
const ALLOWED_METHODS: Readonly<Record<string, true>> = {
	chain_getBlockHash: true,
	chain_getHeader: true,
	chain_getFinalizedHead: true,
	system_health: true,
	system_chain: true,
	state_getRuntimeVersion: true,
	state_call: true,
	chain_subscribeNewHeads: true,
	chain_unsubscribeNewHeads: true,
	chain_subscribeFinalizedHeads: true,
	chain_unsubscribeFinalizedHeads: true,
	state_subscribeRuntimeVersion: true,
	state_unsubscribeRuntimeVersion: true,
};

/**
 * Throws unless the call is on the allowlist. `state_call` is allowed only as
 * `["BabeApi_configuration", "0x"]`, optionally at a block hash.
 */
export function assertAllowed(method: string, params: readonly unknown[]): void {
	if (!Object.hasOwn(ALLOWED_METHODS, method)) throw new Error(`RPC method not allowed: ${method}`);
	if (
		method === "state_call" &&
		!(
			params[0] === "BabeApi_configuration" &&
			params[1] === "0x" &&
			(params.length === 2 || (params.length === 3 && typeof params[2] === "string"))
		)
	) {
		throw new Error(`RPC state_call not allowed: ${String(params[0])}`);
	}
}

export type RpcOutcome =
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

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds from `now`. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
	if (header === null) return null;
	const value = header.trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}

let nextId = 0;

/** Calls `method` once. Throws only for a call outside the allowlist; every failure is returned. */
export async function rpcCall(
	url: string,
	method: string,
	params: readonly unknown[] = [],
	options: { timeoutMs?: number } = {},
): Promise<RpcOutcome> {
	assertAllowed(method, params);
	const started = performance.now();
	const elapsed = () => performance.now() - started;
	let response: Response;
	let text: string;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": USER_AGENT,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
			// A redirect would send the request to an endpoint that is not configured (hard rule 1)
			// and report another host's health; a 3xx is recorded as http_error instead.
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
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
	const httpStatus = response.status;
	const fail = (result: Exclude<ProbeResult, "ok">, error: string): RpcOutcome => ({
		result,
		error,
		ms,
		httpStatus,
		retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
	});
	if (httpStatus === 429) return fail("rate_limited", "HTTP 429");
	if (!response.ok) return fail("http_error", `HTTP ${httpStatus}: ${text.slice(0, 200)}`);

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return fail("invalid_response", `not JSON: ${text.slice(0, 200)}`);
	}
	if (typeof body !== "object" || body === null)
		return fail("invalid_response", "not a JSON object");
	if ("error" in body && body.error !== undefined && body.error !== null) {
		const { error } = body;
		const code = typeof error === "object" && "code" in error ? String(error.code) : "?";
		const message = typeof error === "object" && "message" in error ? String(error.message) : "";
		return fail("rpc_error", `${code} ${message}`.trim());
	}
	if (!("result" in body)) return fail("invalid_response", "neither result nor error");
	return { result: "ok", value: body.result, ms, httpStatus };
}
