import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config";
import { serveHttp } from "./http";
import { ImapSession } from "./imap/session";
import { ImapMail } from "./mail";
import { createServer } from "./server";

const config = loadConfig(process.env);
const session = new ImapSession(config.imap);
const mail = new ImapMail(session, config);
const factory = () => createServer(mail);

// stdout is the MCP channel on stdio, so logs go to stderr.
if (config.http) {
	const http = serveHttp(factory, config.http);
	console.error(`icloud-mcp listening on ${http.url}`);
	const shutdown = () => {
		Promise.all([http.close(), session.close()]).then(
			() => process.exit(0),
			(error: unknown) => {
				console.error("[icloud-mcp] shutdown failed:", error);
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
} else {
	serveStdio(factory);
	console.error("icloud-mcp listening on stdio");
}
