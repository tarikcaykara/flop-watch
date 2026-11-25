// Shared test helpers: a manual clock for injected timers, a time-bounded wait for socket I/O,
// and a reader for single metric samples.

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

/** Lets I/O and promises run until `check` passes, for at most 5 s of real time; never uses a clock. */
export async function eventually(
	check: () => boolean | Promise<boolean>,
	what: string,
): Promise<void> {
	const deadline = performance.now() + 5_000;
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
