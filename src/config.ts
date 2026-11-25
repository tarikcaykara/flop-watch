// Collector configuration: built-in network profiles plus environment overrides (architecture §9).

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface NetworkConfig {
	/** Config key; also the `network` label value. */
	readonly name: string;
	readonly rpcWs: string;
	readonly rpcHttp: string;
	/** Faucet base URL without a trailing slash; null disables the faucet probes. */
	readonly faucetUrl: string | null;
	/** Explorer API base URL without a trailing slash; null disables the explorer probe. */
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
export const PROFILES: Readonly<Record<string, NetworkConfig>> = {
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
		rpcWs: "wss://testnet.flop.network/",
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
const GENESIS_RE = /^0x[0-9a-f]{64}$/i;

const varName = (network: string, field: string) => `${PREFIX}${network.toUpperCase()}_${field}`;

/** Parses `value` as a URL with one of `protocols`; records a problem and returns null otherwise. */
function checkUrl(
	value: string,
	protocols: readonly string[],
	source: string,
	problems: string[],
): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		problems.push(`${source}: not a valid URL: ${JSON.stringify(value)}`);
		return null;
	}
	if (!protocols.includes(url.protocol)) {
		problems.push(`${source}: expected ${protocols.join(" or ")} URL, got ${url.protocol}`);
		return null;
	}
	return value;
}

/**
 * Builds the configuration from the built-in profiles and `env`.
 * Throws one Error that lists every problem found, so a misconfiguration fails fast at startup.
 */
export function loadConfig(env: Env): Config {
	const problems: string[] = [];

	const names = (env[`${PREFIX}NETWORKS`] ?? Object.keys(PROFILES).join(","))
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (names.length === 0) problems.push(`${PREFIX}NETWORKS: no network selected`);
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) problems.push(`${PREFIX}NETWORKS: ${name} listed twice`);
		seen.add(name);
		if (!Object.hasOwn(PROFILES, name)) {
			problems.push(
				`${PREFIX}NETWORKS: unknown network ${JSON.stringify(name)} (known: ${Object.keys(PROFILES).join(", ")})`,
			);
		}
	}

	const known = new Set(GLOBAL_VARS.map((v) => PREFIX + v));
	for (const profile of Object.keys(PROFILES)) {
		for (const field of NETWORK_VARS) known.add(varName(profile, field));
	}
	for (const key of Object.keys(env)) {
		if (key.startsWith(PREFIX) && !known.has(key)) problems.push(`${key}: unknown variable`);
	}

	const networks: NetworkConfig[] = [];
	for (const name of [...seen]) {
		const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
		if (!profile) continue;
		const value = (field: string, fallback: string | null) => env[varName(name, field)] ?? fallback;

		const rpcWs = checkUrl(
			value("RPC_WS", profile.rpcWs) ?? "",
			["ws:", "wss:"],
			varName(name, "RPC_WS"),
			problems,
		);
		const rpcHttp = checkUrl(
			value("RPC_HTTP", profile.rpcHttp) ?? "",
			["http:", "https:"],
			varName(name, "RPC_HTTP"),
			problems,
		);
		const optionalHttp = (field: string, fallback: string | null) => {
			const raw = value(field, fallback);
			if (raw === null || raw.trim() === "") return null;
			const url = checkUrl(raw, ["http:", "https:"], varName(name, field), problems);
			return url === null ? null : url.replace(/\/+$/, "");
		};
		const faucetUrl = optionalHttp("FAUCET_URL", profile.faucetUrl);
		const explorerApiUrl = optionalHttp("EXPLORER_API_URL", profile.explorerApiUrl);

		const genesis = value("EXPECTED_GENESIS", profile.expectedGenesis) ?? "";
		if (!GENESIS_RE.test(genesis)) {
			problems.push(
				`${varName(name, "EXPECTED_GENESIS")}: expected 0x-prefixed 32-byte hex, got ${JSON.stringify(genesis)}`,
			);
		}

		if (rpcWs !== null && rpcHttp !== null && GENESIS_RE.test(genesis)) {
			networks.push({
				name,
				rpcWs,
				rpcHttp,
				faucetUrl,
				explorerApiUrl,
				expectedGenesis: genesis.toLowerCase(),
			});
		}
	}

	// Two networks pointing at the same chain or endpoint would silently mix their series.
	const genesisOwner = new Map<string, string>();
	const urlOwner = new Map<string, string>();
	for (const net of networks) {
		const other = genesisOwner.get(net.expectedGenesis);
		if (other) problems.push(`${net.name} and ${other} share the expected genesis`);
		genesisOwner.set(net.expectedGenesis, net.name);
		for (const url of [net.rpcWs, net.rpcHttp, net.faucetUrl, net.explorerApiUrl]) {
			if (url === null) continue;
			const key = new URL(url).href;
			const owner = urlOwner.get(key);
			if (owner && owner !== net.name)
				problems.push(`${net.name} and ${owner} share the endpoint ${url}`);
			urlOwner.set(key, net.name);
		}
	}

	const host = env[`${PREFIX}HOST`] ?? DEFAULT_HOST;
	if (host.trim() === "") problems.push(`${PREFIX}HOST: must not be empty`);

	const rawPort = env[`${PREFIX}PORT`];
	let port = DEFAULT_PORT;
	if (rawPort !== undefined) {
		port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			problems.push(`${PREFIX}PORT: expected an integer 1-65535, got ${JSON.stringify(rawPort)}`);
		}
	}

	const rawLevel = env[`${PREFIX}LOG_LEVEL`] ?? DEFAULT_LOG_LEVEL;
	const logLevel = LOG_LEVELS.find((level) => level === rawLevel);
	if (!logLevel) {
		problems.push(
			`${PREFIX}LOG_LEVEL: expected one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(rawLevel)}`,
		);
	}

	if (problems.length > 0 || !logLevel) {
		throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
	}
	return { networks, host, port, logLevel };
}
