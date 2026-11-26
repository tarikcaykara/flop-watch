import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { getJson, parseRetryAfter } from "../src/http.ts";
import { failure } from "./helpers.ts";

interface Seen {
	method: string | undefined;
	path: string | undefined;
	headers: IncomingMessage["headers"];
	body: string;
}

let respond: (res: ServerResponse) => void = (res) => res.end();
const seen: Seen[] = [];
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += String(chunk);
	seen.push({ method: req.method, path: req.url, headers: req.headers, body });
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

describe("getJson", () => {
	it("sends a bodiless GET with the flop-watch User-Agent and returns the JSON object", async () => {
		reply(200, '{"stale":false}');
		const outcome = await getJson(`${url}/limits`);
		assert.equal(outcome.result, "ok");
		assert.ok("value" in outcome);
		assert.deepEqual(outcome.value, { stale: false });
		assert.equal(outcome.httpStatus, 200);

		const [request] = seen;
		assert.equal(request?.method, "GET");
		assert.equal(request?.path, "/limits");
		assert.equal(request?.body, "");
		assert.equal(request?.headers["content-type"], undefined);
		assert.match(
			request?.headers["user-agent"] ?? "",
			/^flop-watch\/\S+ \(\+https:\/\/github\.com\/tarikcaykara\/flop-watch\)$/,
		);
	});

	it("reports a non-2xx as http_error with the body's error string only", async () => {
		reply(503, '{"error":"Faucet RPC did not verify the release genesis","signer":"5Abc"}', {
			"retry-after": "60",
		});
		const outcome = failure(await getJson(url));
		assert.equal(outcome.result, "http_error");
		assert.equal(outcome.error, "HTTP 503: Faucet RPC did not verify the release genesis");
		assert.equal(outcome.httpStatus, 503);
		assert.equal(outcome.retryAfterMs, 60_000);

		reply(502, "<html>bad gateway 5Abc</html>");
		assert.equal(failure(await getJson(url)).error, "HTTP 502");
	});

	it("accepts the statuses the caller allows, still requiring a JSON object", async () => {
		const accept = (status: number) => status === 503;
		reply(503, '{"ready":false}', { "retry-after": "60" });
		const outcome = await getJson(url, { accept });
		assert.equal(outcome.result, "ok");
		assert.equal(outcome.httpStatus, 503);

		reply(503, "<html>maintenance</html>");
		assert.equal(failure(await getJson(url, { accept })).result, "http_error");
	});

	it("reports a 2xx that is not a JSON object as invalid_response", async () => {
		for (const body of ["<html>maintenance</html>", "null", "[]", '"text"', "42"]) {
			reply(200, body);
			assert.equal((await getJson(url)).result, "invalid_response", body);
		}
	});

	it("reports 429 as rate_limited, even when the caller accepts every status", async () => {
		reply(429, '{"error":"slow down"}', { "retry-after": "120" });
		const outcome = failure(await getJson(url, { accept: () => true }));
		assert.equal(outcome.result, "rate_limited");
		assert.equal(outcome.retryAfterMs, 120_000);
	});

	it("does not follow redirects: a 3xx is an http_error and nothing else is contacted", async () => {
		const elsewhere: string[] = [];
		const target = createServer((req, res) => {
			elsewhere.push(req.url ?? "");
			res.end("{}");
		}).listen(0, "127.0.0.1");
		await once(target, "listening");
		const address = target.address();
		assert.ok(address && typeof address === "object");
		try {
			reply(302, "", { location: `http://127.0.0.1:${address.port}/limits` });
			const outcome = failure(await getJson(`${url}/limits`));
			assert.equal(outcome.result, "http_error");
			assert.equal(outcome.httpStatus, 302);
			assert.deepEqual(elsewhere, []);
		} finally {
			target.close();
		}
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
