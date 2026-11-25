import pkg from "../package.json" with { type: "json" };

/** The package version; reported by `flopwatch_build_info` and sent in the User-Agent. */
export const VERSION: string = pkg.version;

/** Sent with every outbound request, so FLOP operators can identify and contact the project. */
export const USER_AGENT = `flop-watch/${VERSION} (+https://github.com/tarikcaykara/flop-watch)`;
