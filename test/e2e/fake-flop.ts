// The fake FLOP service of the stack e2e. Stub: it answers only its health check.

import { createServer } from "node:http";

const PORT = 8080;

createServer((request, response) => {
	response.writeHead(request.url === "/healthz" ? 200 : 404).end();
}).listen(PORT);

// PID 1 in its container: without a handler, SIGTERM would wait for Docker's SIGKILL.
process.once("SIGTERM", () => process.exit(0));
