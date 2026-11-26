// JSON-RPC 2.0 over HTTP, behind the read-only method allowlist (architecture §11, hard rule 2).
// A failed call is a measurement, not an exception: rpcCall classifies it and returns.

import { type HttpOutcome, send } from "./http.ts";

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

let nextId = 0;

/** Calls `method` once. Throws only for a call outside the allowlist; every failure is returned. */
export async function rpcCall(
	url: string,
	method: string,
	params: readonly unknown[] = [],
	options: { timeoutMs?: number } = {},
): Promise<HttpOutcome> {
	assertAllowed(method, params);
	const reply = await send(
		url,
		{ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }) },
		options.timeoutMs,
	);
	if ("result" in reply) return reply;
	const { status, text } = reply;
	if (status === 429) return reply.fail("rate_limited", "HTTP 429");
	if (status < 200 || status >= 300) {
		return reply.fail("http_error", `HTTP ${status}: ${text.slice(0, 200)}`);
	}

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return reply.fail("invalid_response", `not JSON: ${text.slice(0, 200)}`);
	}
	if (typeof body !== "object" || body === null)
		return reply.fail("invalid_response", "not a JSON object");
	if ("error" in body && body.error !== undefined && body.error !== null) {
		const { error } = body;
		const code = typeof error === "object" && "code" in error ? String(error.code) : "?";
		const message = typeof error === "object" && "message" in error ? String(error.message) : "";
		return reply.fail("rpc_error", `${code} ${message}`.trim());
	}
	if (!("result" in body)) return reply.fail("invalid_response", "neither result nor error");
	return { result: "ok", value: body.result, ms: reply.ms, httpStatus: status };
}
