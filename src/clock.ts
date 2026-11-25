// Timer injection shared by the chain watcher and the probes: production uses real timers, tests
// pass a manual clock instead of mocking global timers (architecture §2, Tests).

/** Runs `fn` after `ms` milliseconds and returns a function that cancels it. */
export type Schedule = (ms: number, fn: () => void) => () => void;

export const realSchedule: Schedule = (ms, fn) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};
