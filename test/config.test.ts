import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const DEVNET_GENESIS = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
const TESTNET_GENESIS = "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800";

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
	it("defaults to both networks with the endpoints and genesis hashes verified in research", () => {
		const config = loadConfig({});
		assert.deepEqual(config.networks, [
			{
				name: "devnet",
				rpcWs: "wss://rpc.devnet.flop.network",
				rpcHttp: "https://rpc.devnet.flop.network",
				faucetUrl: "https://faucet.devnet.flop.network",
				explorerApiUrl: "https://explorer.devnet.flop.network/api",
				expectedGenesis: DEVNET_GENESIS,
			},
			{
				name: "testnet",
				rpcWs: "wss://testnet.flop.network",
				rpcHttp: "https://testnet.flop.network",
				faucetUrl: "https://faucet.flop.network",
				explorerApiUrl: "https://testnet.flopscan.io/api",
				expectedGenesis: TESTNET_GENESIS,
			},
		]);
		assert.equal(config.host, "0.0.0.0");
		assert.equal(config.port, 10063);
		assert.equal(config.logLevel, "info");
	});

	it("selects networks and applies trimmed, normalised overrides", () => {
		const config = loadConfig({
			FLOPWATCH_NETWORKS: " testnet ",
			FLOPWATCH_TESTNET_RPC_WS: " ws://127.0.0.1:9944/ ",
			FLOPWATCH_TESTNET_FAUCET_URL: "http://LOCALHOST:3000/faucet/",
			FLOPWATCH_TESTNET_EXPECTED_GENESIS: `0x${TESTNET_GENESIS.slice(2).toUpperCase()}`,
			FLOPWATCH_HOST: "127.0.0.1",
			FLOPWATCH_PORT: "9100",
			FLOPWATCH_LOG_LEVEL: "debug",
		});
		assert.equal(config.networks.length, 1);
		const [testnet] = config.networks;
		assert.equal(testnet?.rpcWs, "ws://127.0.0.1:9944");
		assert.equal(testnet?.rpcHttp, "https://testnet.flop.network");
		assert.equal(testnet?.faucetUrl, "http://localhost:3000/faucet");
		assert.equal(testnet?.expectedGenesis, TESTNET_GENESIS);
		assert.equal(config.host, "127.0.0.1");
		assert.equal(config.port, 9100);
		assert.equal(config.logLevel, "debug");
	});

	it("treats an empty value as the default, but an empty faucet or explorer URL as disabled", () => {
		const config = loadConfig({
			FLOPWATCH_NETWORKS: "",
			FLOPWATCH_HOST: " ",
			FLOPWATCH_DEVNET_RPC_WS: "",
			FLOPWATCH_DEVNET_FAUCET_URL: "",
			FLOPWATCH_DEVNET_EXPLORER_API_URL: " ",
		});
		assert.equal(config.networks.length, 2);
		assert.equal(config.host, "0.0.0.0");
		const [devnet] = config.networks;
		assert.equal(devnet?.rpcWs, "wss://rpc.devnet.flop.network");
		assert.equal(devnet?.faucetUrl, null);
		assert.equal(devnet?.explorerApiUrl, null);
	});

	it("rejects unknown and duplicate network selections", () => {
		assertProblems({ FLOPWATCH_NETWORKS: "mainnet" }, /unknown network "mainnet"/);
		assertProblems({ FLOPWATCH_NETWORKS: "toString" }, /unknown network "toString"/);
		assertProblems({ FLOPWATCH_NETWORKS: "__proto__" }, /unknown network "__proto__"/);
		assertProblems({ FLOPWATCH_NETWORKS: "testnet,testnet" }, /testnet listed twice/);
		assertProblems({ FLOPWATCH_NETWORKS: " , " }, /no network selected/);
	});

	it("rejects malformed URLs, wrong schemes, queries and credentials", () => {
		assertProblems(
			{ FLOPWATCH_TESTNET_RPC_WS: "not a url" },
			/FLOPWATCH_TESTNET_RPC_WS: not a valid URL/,
		);
		assertProblems(
			{ FLOPWATCH_TESTNET_RPC_WS: "https://testnet.flop.network" },
			/FLOPWATCH_TESTNET_RPC_WS: expected a ws:/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "wss://rpc.devnet.flop.network" },
			/FLOPWATCH_DEVNET_RPC_HTTP: expected a http:/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_EXPLORER_API_URL: "ftp://example.org" },
			/FLOPWATCH_DEVNET_EXPLORER_API_URL/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_FAUCET_URL: "https://faucet.example/?x=1" },
			/FLOPWATCH_DEVNET_FAUCET_URL: query strings/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "https://user:pw@rpc.example" },
			/FLOPWATCH_DEVNET_RPC_HTTP: query strings/,
		);
	});

	it("rejects a genesis that is not 32-byte hex", () => {
		assertProblems(
			{ FLOPWATCH_TESTNET_EXPECTED_GENESIS: "0x1234" },
			/FLOPWATCH_TESTNET_EXPECTED_GENESIS: expected 0x-prefixed/,
		);
	});

	it("rejects two networks sharing a genesis, whatever its case", () => {
		assertProblems(
			{ FLOPWATCH_DEVNET_EXPECTED_GENESIS: TESTNET_GENESIS.toUpperCase().replace("0X", "0x") },
			/EXPECTED_GENESIS: same genesis as/,
		);
	});

	it("rejects two networks sharing an endpoint, across fields and schemes", () => {
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "https://testnet.flop.network/" },
			/same endpoint as/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_HTTP: "http://testnet.flop.network" },
			/same endpoint as/,
		);
		assertProblems(
			{ FLOPWATCH_DEVNET_EXPLORER_API_URL: "https://faucet.flop.network" },
			/same endpoint as/,
		);
	});

	it("still reports a shared genesis when another field of the network is invalid", () => {
		assertProblems(
			{ FLOPWATCH_DEVNET_RPC_WS: "nope", FLOPWATCH_DEVNET_EXPECTED_GENESIS: TESTNET_GENESIS },
			/FLOPWATCH_DEVNET_RPC_WS/,
			/same genesis as/,
		);
	});

	it("rejects out-of-range or non-integer ports and unknown log levels", () => {
		for (const port of ["0", "65536", "-1", "1e3", "80a"]) {
			assertProblems({ FLOPWATCH_PORT: port }, /FLOPWATCH_PORT: expected an integer 1-65535/);
		}
		assertProblems({ FLOPWATCH_LOG_LEVEL: "trace" }, /FLOPWATCH_LOG_LEVEL: expected one of/);
	});

	it("rejects unknown FLOPWATCH_ variables, catching typos", () => {
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
