import pkg from "../package.json" with { type: "json" };

/** The package version; reported by `flopwatch_build_info` and sent in the User-Agent. */
export const VERSION: string = pkg.version;
