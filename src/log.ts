// JSON-lines logging to stdout: one object per line with time, level, msg and optional fields.

import type { LogLevel } from "./config.ts";

export type LogFields = Readonly<Record<string, unknown>>;
export type Logger = Readonly<Record<LogLevel, (msg: string, fields?: LogFields) => void>>;

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Errors become `{name, message}` and bigints become strings; JSON.stringify drops or throws on both. */
function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) return { name: value.name, message: value.message };
	if (typeof value === "bigint") return value.toString();
	return value;
}

/** `fields` must not use the keys `time`, `level` or `msg`. */
export function createLogger(
	minLevel: LogLevel,
	write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
	const at =
		(level: LogLevel) =>
		(msg: string, fields: LogFields = {}): void => {
			if (RANK[level] < RANK[minLevel]) return;
			write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, replacer));
		};
	return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
