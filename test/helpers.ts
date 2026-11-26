// Shared test helpers: a manual clock for injected timers, a time-bounded wait for socket I/O, a
// reader for single metric samples, a failed-outcome assertion, and the recorded faucet and
// explorer bodies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HttpOutcome } from "../src/http.ts";

export interface ManualClock {
	readonly now: () => number;
	readonly schedule: (ms: number, fn: () => void) => () => void;
	/** Moves time forward, running every task that falls due, in order. */
	readonly advance: (ms: number) => void;
}

/** A manual clock for the `schedule`/`now` options: nothing fires until the test advances it. */
export function manualClock(): ManualClock {
	let now = 0;
	let nextId = 0;
	const tasks = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		schedule: (ms: number, fn: () => void) => {
			const id = ++nextId;
			tasks.set(id, { at: now + ms, fn });
			return () => tasks.delete(id);
		},
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const due = [...tasks]
					.filter(([, task]) => task.at <= until)
					.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!due) break;
				tasks.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = until;
		},
	};
}

/** Lets I/O and promises run until `check` passes, within `timeoutMs` of real time; never uses a clock. */
export async function eventually(
	check: () => boolean | Promise<boolean>,
	what: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`never happened: ${what}`);
}

interface Sample {
	value: number;
	labels: Record<string, string | number>;
	metricName?: string;
}

/** The first sample of `metric` whose labels include `labels` (and, for histograms, `metricName`). */
export async function sample(
	metric: { get(): Promise<{ values: Sample[] }> },
	labels: Record<string, string> = {},
	metricName?: string,
): Promise<number | undefined> {
	const { values } = await metric.get();
	return values.find(
		(v) =>
			(metricName === undefined || v.metricName === metricName) &&
			Object.entries(labels).every(([k, value]) => v.labels[k] === value),
	)?.value;
}

interface ServiceFixtures {
	networks: Record<string, Record<string, Record<string, unknown>>>;
}
const services: ServiceFixtures = JSON.parse(
	readFileSync(new URL("fixtures/services.json", import.meta.url), "utf8"),
);

/** A recorded body from fixtures/services.json; fails the test when it was not recorded. */
export function serviceBody(
	network: "devnet" | "testnet",
	target: string,
	status: 200 | 503,
): unknown {
	const value = services.networks[network]?.[target]?.[String(status)];
	assert.ok(value !== undefined, `fixture ${network} ${target} ${status}`);
	return value;
}

export const REMOVE = Symbol("remove");

/** A deep copy of `source` with the value at the dotted `path` replaced, or removed. */
export function withField(source: unknown, path: string, value: unknown): unknown {
	const copy = structuredClone(source);
	const keys = path.split(".");
	const last = keys.pop();
	let parent: unknown = copy;
	for (const key of keys) {
		assert.ok(typeof parent === "object" && parent !== null, `path ${path}`);
		parent = Reflect.get(parent, key);
	}
	assert.ok(typeof parent === "object" && parent !== null && last !== undefined, `path ${path}`);
	if (value === REMOVE) Reflect.deleteProperty(parent, last);
	else Reflect.set(parent, last, value);
	return copy;
}

/** Asserts that `outcome` is a failure and returns it narrowed. */
export function failure(outcome: HttpOutcome) {
	assert.notEqual(outcome.result, "ok");
	assert.ok("error" in outcome);
	return outcome;
}
