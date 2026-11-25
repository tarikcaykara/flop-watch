// Entry point: load the config, serve /metrics and /healthz, shut down cleanly on SIGTERM/SIGINT.
// Network workers are started here from #7.

import { createServer, type Server } from "node:http";
import { type Config, loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { VERSION } from "./version.ts";

const SHUTDOWN_GRACE_MS = 5_000;

/** Serves GET/HEAD /metrics and /healthz; other paths get 404, other methods 405. */
export function startMetricsServer(options: {
	host: string;
	port: number;
	metrics: Metrics;
	log: Logger;
}): Promise<Server> {
	const { metrics, log } = options;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { allow: "GET, HEAD" }).end();
		} else if (path === "/healthz") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
		} else if (path !== "/metrics") {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
		} else {
			metrics.registry.metrics().then(
				(body) => res.writeHead(200, { "content-type": metrics.registry.contentType }).end(body),
				(err: unknown) => {
					log.error("metrics collection failed", { err });
					res.writeHead(500).end();
				},
			);
		}
	});
	const { promise, resolve, reject } = Promise.withResolvers<Server>();
	server.once("error", reject);
	server.listen(options.port, options.host, () => {
		server.off("error", reject);
		resolve(server);
	});
	return promise;
}

async function main(): Promise<void> {
	let config: Config;
	try {
		config = loadConfig(process.env);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
		return;
	}
	const log = createLogger(config.logLevel);
	process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { err: reason }));

	const metrics = createMetrics();
	const server = await startMetricsServer({
		host: config.host,
		port: config.port,
		metrics,
		log,
	});
	log.info("flop-watch started", {
		version: VERSION,
		host: config.host,
		port: config.port,
		networks: config.networks.map((n) => n.name),
	});

	let stopping = false;
	const shutdown = (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		log.info("shutting down", { signal });
		setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
		server.close(() => process.exit(0));
		server.closeAllConnections();
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}

if (import.meta.main) await main();
