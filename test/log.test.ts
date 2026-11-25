import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "../src/log.ts";

describe("createLogger", () => {
	it("writes one JSON object per line at or above the minimum level", () => {
		const lines: string[] = [];
		const log = createLogger("info", (line) => lines.push(line));
		log.debug("hidden");
		log.info("shown", { network: "testnet" });
		log.error("failed", { err: new TypeError("boom"), slot: 1795635206n });

		assert.equal(lines.length, 2);
		const [info, error] = lines.map((line) => JSON.parse(line));
		assert.equal(info.level, "info");
		assert.equal(info.msg, "shown");
		assert.equal(info.network, "testnet");
		assert.ok(!Number.isNaN(Date.parse(info.time)));
		assert.deepEqual(error.err, { name: "TypeError", message: "boom" });
		assert.equal(error.slot, "1795635206");
	});
});
