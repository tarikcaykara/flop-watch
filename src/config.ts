// Collector configuration: built-in network profiles plus environment overrides (architecture §9).

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type NetworkName = "devnet" | "testnet";

export interface NetworkConfig {
	/** Config key; also the `network` label value. */
	readonly name: NetworkName;
	readonly rpcWs: string;
	readonly rpcHttp: string;
	/** Faucet base URL; null disables the faucet probes. */
	readonly faucetUrl: string | null;
	/** Explorer API base URL; null disables the explorer probe. */
	readonly explorerApiUrl: string | null;
	/** Lower-case 0x-prefixed 32-byte hex. */
	readonly expectedGenesis: string;
}

export interface Config {
	readonly networks: readonly NetworkConfig[];
	readonly host: string;
	readonly port: number;
	readonly logLevel: LogLevel;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Endpoints and genesis hashes verified on 2026-11-25 (docs/research.md §2, §4). */
export const PROFILES: Readonly<Record<NetworkName, NetworkConfig>> = {
	devnet: {
		name: "devnet",
		rpcWs: "wss://rpc.devnet.flop.network",
		rpcHttp: "https://rpc.devnet.flop.network",
		faucetUrl: "https://faucet.devnet.flop.network",
		explorerApiUrl: "https://explorer.devnet.flop.network/api",
		expectedGenesis: "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631",
	},
	testnet: {
		name: "testnet",
		rpcWs: "wss://testnet.flop.network",
		rpcHttp: "https://testnet.flop.network",
		faucetUrl: "https://faucet.flop.network",
		explorerApiUrl: "https://testnet.flopscan.io/api",
		expectedGenesis: "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800",
	},
};

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 10063;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const PREFIX = "FLOPWATCH_";
const GLOBAL_VARS = ["NETWORKS", "HOST", "PORT", "LOG_LEVEL"];
const NETWORK_VARS = ["RPC_WS", "RPC_HTTP", "FAUCET_URL", "EXPLORER_API_URL", "EXPECTED_GENESIS"];
const WS = ["ws:", "wss:"];
const HTTP = ["http:", "https:"];
const GENESIS_RE = /^0x[0-9a-f]{64}$/;

const isNetworkName = (name: string): name is NetworkName => Object.hasOwn(PROFILES, name);
const varName = (network: string, field: string) => `${PREFIX}${network.toUpperCase()}_${field}`;

/**
 * Validates a base URL and returns it as origin + path without a trailing slash, so probes can
 * append paths. Records a problem and returns null when it is invalid.
 */
function baseUrl(
	raw: string,
	protocols: readonly string[],
	variable: string,
	problems: string[],
): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		problems.push(`${variable}: not a valid URL: ${JSON.stringify(raw)}`);
		return null;
	}
	if (!protocols.includes(url.protocol)) {
		problems.push(`${variable}: expected a ${protocols.join(" or ")} URL, got ${url.protocol}`);
		return null;
	}
	if (url.search || url.hash || url.username || url.password) {
		problems.push(`${variable}: query strings, fragments and credentials are not supported`);
		return null;
	}
	return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Builds the configuration from the built-in profiles and `env`. Values are trimmed, and an empty
 * value means "use the default", except for the faucet and explorer URLs, where an empty value
 * disables the probe. Throws one Error listing every problem, so a misconfiguration fails fast.
 */
export function loadConfig(env: Env): Config {
	const problems: string[] = [];
	const setting = (variable: string): string | undefined => {
		const value = env[variable]?.trim();
		return value === "" ? undefined : value;
	};

	const known = new Set(GLOBAL_VARS.map((v) => PREFIX + v));
	for (const network of Object.keys(PROFILES)) {
		for (const field of NETWORK_VARS) known.add(varName(network, field));
	}
	for (const key of Object.keys(env)) {
		if (key.startsWith(PREFIX) && !known.has(key)) problems.push(`${key}: unknown variable`);
	}

	const selected: NetworkName[] = [];
	const names = (setting(`${PREFIX}NETWORKS`) ?? Object.keys(PROFILES).join(","))
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (names.length === 0) problems.push(`${PREFIX}NETWORKS: no network selected`);
	for (const name of names) {
		if (!isNetworkName(name)) {
			const knownNames = Object.keys(PROFILES).join(", ");
			problems.push(
				`${PREFIX}NETWORKS: unknown network ${JSON.stringify(name)} (known: ${knownNames})`,
			);
		} else if (selected.includes(name)) {
			problems.push(`${PREFIX}NETWORKS: ${name} listed twice`);
		} else {
			selected.push(name);
		}
	}

	// Two networks pointing at the same chain or endpoint would silently mix their series.
	const genesisOwner = new Map<string, string>();
	const endpointOwner = new Map<string, { network: NetworkName; variable: string }>();
	const networks: NetworkConfig[] = [];
	for (const name of selected) {
		const profile = PROFILES[name];
		const v = (field: string) => varName(name, field);
		const optionalUrl = (field: string, fallback: string | null) => {
			const raw = env[v(field)]?.trim() ?? fallback;
			return raw ? baseUrl(raw, HTTP, v(field), problems) : null;
		};

		const rpcWs = baseUrl(setting(v("RPC_WS")) ?? profile.rpcWs, WS, v("RPC_WS"), problems);
		const rpcHttp = baseUrl(
			setting(v("RPC_HTTP")) ?? profile.rpcHttp,
			HTTP,
			v("RPC_HTTP"),
			problems,
		);
		const faucetUrl = optionalUrl("FAUCET_URL", profile.faucetUrl);
		const explorerApiUrl = optionalUrl("EXPLORER_API_URL", profile.explorerApiUrl);

		const expectedGenesis = (
			setting(v("EXPECTED_GENESIS")) ?? profile.expectedGenesis
		).toLowerCase();
		if (!GENESIS_RE.test(expectedGenesis)) {
			problems.push(
				`${v("EXPECTED_GENESIS")}: expected 0x-prefixed 32-byte hex, got ${JSON.stringify(expectedGenesis)}`,
			);
		} else {
			const owner = genesisOwner.get(expectedGenesis);
			if (owner) problems.push(`${v("EXPECTED_GENESIS")}: same genesis as ${owner}`);
			else genesisOwner.set(expectedGenesis, v("EXPECTED_GENESIS"));
		}

		const endpoints: Array<[string, string | null]> = [
			[v("RPC_WS"), rpcWs],
			[v("RPC_HTTP"), rpcHttp],
			[v("FAUCET_URL"), faucetUrl],
			[v("EXPLORER_API_URL"), explorerApiUrl],
		];
		for (const [variable, url] of endpoints) {
			if (url === null) continue;
			// The scheme is ignored: wss:// and https:// on the same host and path reach the same node.
			const key = url.replace(/^[a-z]+:\/\//, "");
			const owner = endpointOwner.get(key);
			if (!owner) endpointOwner.set(key, { network: name, variable });
			else if (owner.network !== name) {
				problems.push(`${variable}: same endpoint as ${owner.variable} (${url})`);
			}
		}

		if (rpcWs !== null && rpcHttp !== null) {
			networks.push({ name, rpcWs, rpcHttp, faucetUrl, explorerApiUrl, expectedGenesis });
		}
	}

	const host = setting(`${PREFIX}HOST`) ?? DEFAULT_HOST;

	let port = DEFAULT_PORT;
	const rawPort = setting(`${PREFIX}PORT`);
	if (rawPort !== undefined) {
		port = Number(rawPort);
		if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
			problems.push(`${PREFIX}PORT: expected an integer 1-65535, got ${JSON.stringify(rawPort)}`);
		}
	}

	let logLevel = DEFAULT_LOG_LEVEL;
	const rawLevel = setting(`${PREFIX}LOG_LEVEL`);
	if (rawLevel !== undefined) {
		const level = LOG_LEVELS.find((l) => l === rawLevel);
		if (level) logLevel = level;
		else {
			problems.push(
				`${PREFIX}LOG_LEVEL: expected one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(rawLevel)}`,
			);
		}
	}

	if (problems.length > 0) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
	return { networks, host, port, logLevel };
}
