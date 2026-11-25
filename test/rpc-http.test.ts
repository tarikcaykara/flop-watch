import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { assertAllowed, parseRetryAfter, type RpcOutcome, rpcCall } from "../src/rpc-http.ts";

interface Seen {
	method: string | undefined;
	headers: IncomingMessage["headers"];
	body: unknown;
}

let respond: (res: ServerResponse) => void = (res) => res.end();
const seen: Seen[] = [];
const server = createServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) raw += String(chunk);
	seen.push({ method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
	respond(res);
});
let url = "";

before(async () => {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	url = `http://127.0.0.1:${address.port}`;
});
after(() => {
	server.closeAllConnections();
	server.close();
});
beforeEach(() => {
	seen.length = 0;
});

function reply(status: number, body: string, headers: Record<string, string> = {}): void {
	respond = (res) =>
		res.writeHead(status, { "content-type": "application/json", ...headers }).end(body);
}

function failure(outcome: RpcOutcome) {
	assert.notEqual(outcome.result, "ok");
	assert.ok("error" in outcome);
	return outcome;
}

describe("rpcCall", () => {
	it("posts a JSON-RPC 2.0 request with the flop-watch User-Agent and returns the result", async () => {
		reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }));
		const outcome = await rpcCall(url, "chain_getBlockHash", [0]);
		assert.equal(outcome.result, "ok");
		assert.ok("value" in outcome);
		assert.equal(outcome.value, "0xabc");
		assert.equal(outcome.httpStatus, 200);
		assert.ok(outcome.ms >= 0);

		const [request] = seen;
		assert.equal(request?.method, "POST");
		assert.match(
			request?.headers["user-agent"] ?? "",
			/^flop-watch\/\S+ \(\+https:\/\/github\.com\/tarikcaykara\/flop-watch\)$/,
		);
		assert.match(request?.headers["content-type"] ?? "", /^application\/json/);
		const body = request?.body;
		assert.ok(typeof body === "object" && body !== null && "id" in body);
		assert.equal(typeof body.id, "number");
		assert.deepEqual(
			{ ...body, id: 0 },
			{ jsonrpc: "2.0", id: 0, method: "chain_getBlockHash", params: [0] },
		);
	});

	it("classifies a JSON-RPC error", async () => {
		reply(
			200,
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32601, message: "Method not found" },
			}),
		);
		const outcome = failure(await rpcCall(url, "system_health"));
		assert.equal(outcome.result, "rpc_error");
		assert.equal(outcome.error, "-32601 Method not found");
	});

	it("classifies non-2xx answers and reads Retry-After in seconds", async () => {
		reply(503, '{"error":"busy"}', { "retry-after": "60" });
		const outcome = failure(await rpcCall(url, "system_health"));
		assert.equal(outcome.result, "http_error");
		assert.equal(outcome.httpStatus, 503);
		assert.equal(outcome.retryAfterMs, 60_000);
	});

	it("classifies 429 as rate_limited and reads a Retry-After date", async () => {
		reply(429, "", { "retry-after": new Date(Date.now() + 30_000).toUTCString() });
		const outcome = failure(await rpcCall(url, "system_health"));
		assert.equal(outcome.result, "rate_limited");
		assert.ok(
			outcome.retryAfterMs !== null &&
				outcome.retryAfterMs > 27_000 &&
				outcome.retryAfterMs <= 30_000,
		);
	});

	it("classifies bodies that are not JSON-RPC responses as invalid_response", async () => {
		reply(200, "<html>maintenance</html>");
		assert.equal((await rpcCall(url, "system_health")).result, "invalid_response");
		reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1 }));
		assert.equal((await rpcCall(url, "system_health")).result, "invalid_response");
		reply(200, "null");
		assert.equal((await rpcCall(url, "system_health")).result, "invalid_response");
	});

	it("keeps a null result as ok, for the caller to interpret", async () => {
		reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
		const outcome = await rpcCall(url, "chain_getBlockHash", [999_999_999]);
		assert.equal(outcome.result, "ok");
	});

	it("classifies a request that outlives the timeout", async () => {
		respond = () => {}; // never answers
		const outcome = failure(await rpcCall(url, "system_health", [], { timeoutMs: 200 }));
		assert.equal(outcome.result, "timeout");
		assert.equal(outcome.httpStatus, null);
	});

	it("classifies an unreachable endpoint as network_error", async () => {
		const outcome = failure(await rpcCall("http://127.0.0.1:1", "system_health"));
		assert.equal(outcome.result, "network_error");
	});
});

describe("method allowlist", () => {
	it("refuses writes and other runtime calls before anything is sent", async () => {
		reply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }));
		await assert.rejects(
			rpcCall(url, "author_submitExtrinsic", ["0x00"]),
			/not allowed: author_submitExtrinsic/,
		);
		await assert.rejects(
			rpcCall(url, "state_call", ["Core_version", "0x"]),
			/state_call not allowed/,
		);
		await assert.rejects(
			rpcCall(url, "state_call", ["BabeApi_configuration", "0x01"]),
			/state_call not allowed/,
		);
		await assert.rejects(rpcCall(url, "toString"), /not allowed/);
		assert.equal(seen.length, 0);
	});

	it("allows the read methods flop-watch uses", () => {
		for (const method of [
			"chain_getBlockHash",
			"chain_getHeader",
			"chain_getFinalizedHead",
			"system_health",
			"system_chain",
			"state_getRuntimeVersion",
			"chain_subscribeNewHeads",
			"chain_unsubscribeNewHeads",
			"chain_subscribeFinalizedHeads",
			"chain_unsubscribeFinalizedHeads",
			"state_subscribeRuntimeVersion",
			"state_unsubscribeRuntimeVersion",
		]) {
			assert.doesNotThrow(() => assertAllowed(method, []), method);
		}
		assert.doesNotThrow(() => assertAllowed("state_call", ["BabeApi_configuration", "0x"]));
	});
});

describe("parseRetryAfter", () => {
	it("reads delta-seconds and HTTP-dates, and ignores anything else", () => {
		const now = Date.parse("2026-11-25T12:00:00Z");
		assert.equal(parseRetryAfter("120", now), 120_000);
		assert.equal(parseRetryAfter("Wed, 25 Nov 2026 12:00:30 GMT", now), 30_000);
		assert.equal(parseRetryAfter("Wed, 25 Nov 2026 11:00:00 GMT", now), 0);
		assert.equal(parseRetryAfter("soon", now), null);
		assert.equal(parseRetryAfter(null, now), null);
	});
});
