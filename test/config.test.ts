import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PORT, loadConfig, PROFILES } from "../src/config.ts";

const TESTNET_GENESIS = PROFILES["testnet"]?.expectedGenesis ?? "";

/** Asserts that loadConfig throws and that its message names every expected problem. */
function assertProblems(env: Record<string, string>, ...expected: RegExp[]): void {
	assert.throws(
		() => loadConfig(env),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			for (const re of expected) assert.match(err.message, re);
			return true;
		},
	);
}

describe("loadConfig", () => {
	it("defaults to both built-in networks with the verified endpoints", () => {
		const config = loadConfig({});
		assert.deepEqual(
			config.networks.map((n) => n.name),
			["devnet", "testnet"],
		);
		assert.deepEqual(config.networks[1], PROFILES["testnet"]);
		assert.equal(config.host, "0.0.0.0");
		assert.equal(config.port, DEFAULT_PORT);
		assert.equal(config.logLevel, "info");
	});

	it("selects networks and applies per-network overrides", () => {
		const config = loadConfig({
			FLOPWATCH_NETWORKS: " testnet ",
			FLOPWATCH_TESTNET_RPC_WS: "ws://127.0.0.1:9944",
			FLOPWATCH_TESTNET_FAUCET_URL: "http://127.0.0.1:3000/",
			FLOPWATCH_TESTNET_EXPECTED_GENESIS: TESTNET_GENESIS.toUpperCase().replace("0X", "0x"),
			FLOPWATCH_PORT: "9100",
			FLOPWATCH_LOG_LEVEL: "debug",
		});
		assert.equal(config.networks.length, 1);
		const [testnet] = config.networks;
		assert.equal(testnet?.rpcWs, "ws://127.0.0.1:9944");
		assert.equal(testnet?.rpcHttp, PROFILES["testnet"]?.rpcHttp);
		assert.equal(testnet?.faucetUrl, "http://127.0.0.1:3000", "trailing slash is dropped");
		assert.equal(testnet?.expectedGenesis, TESTNET_GENESIS, "genesis is normalised to lower case");
		assert.equal(config.port, 9100);
		assert.equal(config.logLevel, "debug");
	});

	it("disables the faucet and explorer probes when their URL is empty", () => {
		const config = loadConfig({
			FLOPWATCH_NETWORKS: "devnet",
			FLOPWATCH_DEVNET_FAUCET_URL: "",
			FLOPWATCH_DEVNET_EXPLORER_API_URL: " ",
		});
		assert.equal(config.networks[0]?.faucetUrl, null);
		assert.equal(config.networks[0]?.explorerApiUrl, null);
	});

	it("rejects unknown, duplicate and empty network selections", () => {
		assertProblems({ FLOPWATCH_NETWORKS: "mainnet" }, /unknown network "mainnet"/);
		assertProblems({ FLOPWATCH_NETWORKS: "toString" }, /unknown network "toString"/);
		assertProblems({ FLOPWATCH_NETWORKS: "testnet,testnet" }, /testnet listed twice/);
		assertProblems({ FLOPWATCH_NETWORKS: " , " }, /no network selected/);
	});

	it("rejects malformed URLs and wrong schemes per field", () => {
		assertProblems(
			{ FLOPWATCH_TESTNET_RPC_WS: "not a url" },
			/FLOPWATCH_TESTNET_RPC_WS: not a valid URL/,
		);
		assertProblems(
			{ FLOPWATCH_TESTNET_RPC_WS: "https://testnet.flop.network" },
			/FLOPWATCH_TESTNET_RPC_WS: expected ws: or wss: URL/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "wss://rpc.devnet.flop.network" },
			/FLOPWATCH_DEVNET_RPC_HTTP: expected http: or https: URL/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_EXPLORER_API_URL: "ftp://example.org" },
			/FLOPWATCH_DEVNET_EXPLORER_API_URL: expected http: or https: URL/,
		);
	});

	it("rejects a genesis that is not 32-byte hex", () => {
		assertProblems(
			{ FLOPWATCH_TESTNET_EXPECTED_GENESIS: "0x1234" },
			/FLOPWATCH_TESTNET_EXPECTED_GENESIS: expected 0x-prefixed 32-byte hex/,
		);
	});

	it("rejects two networks sharing a genesis or an endpoint", () => {
		assertProblems(
			{ FLOPWATCH_DEVNET_EXPECTED_GENESIS: TESTNET_GENESIS },
			/testnet and devnet share the expected genesis/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "https://testnet.flop.network/" },
			/testnet and devnet share the endpoint/,
		);
	});

	it("rejects an invalid port, log level, host or unknown variable", () => {
		assertProblems({ FLOPWATCH_PORT: "0" }, /FLOPWATCH_PORT: expected an integer 1-65535/);
		assertProblems({ FLOPWATCH_PORT: "80a" }, /FLOPWATCH_PORT/);
		assertProblems({ FLOPWATCH_LOG_LEVEL: "trace" }, /FLOPWATCH_LOG_LEVEL: expected one of/);
		assertProblems({ FLOPWATCH_HOST: "" }, /FLOPWATCH_HOST: must not be empty/);
		assertProblems(
			{ FLOPWATCH_TESTNET_RPC_WSS: "wss://x" },
			/FLOPWATCH_TESTNET_RPC_WSS: unknown variable/,
		);
	});

	it("reports every problem at once", () => {
		assertProblems(
			{
				FLOPWATCH_PORT: "70000",
				FLOPWATCH_LOG_LEVEL: "loud",
				FLOPWATCH_TESTNET_EXPECTED_GENESIS: "x",
			},
			/FLOPWATCH_PORT/,
			/FLOPWATCH_LOG_LEVEL/,
			/FLOPWATCH_TESTNET_EXPECTED_GENESIS/,
		);
	});
});
