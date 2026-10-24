import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../package.json" with { type: "json" };
import type { Mail } from "./mail";
import { registerComposeTools } from "./tools/compose";
import { registerOrganizeTools } from "./tools/organize";
import { registerReadTools } from "./tools/read";

const INSTRUCTIONS = [
	"Messages are identified by mailbox name plus UID; mail_search returns UIDs, and a UID stays valid while the message stays in that mailbox.",
	"To delete messages, move them to the mailbox mail_list_mailboxes marks as trash.",
	"mail_send delivers immediately and cannot be undone: confirm recipients, subject, and body with the user first, or use mail_save_draft so they send it themselves.",
].join(" ");

/** Builds a server instance; the transport layer calls this per connection or request. */
export function createServer(mail: Mail): McpServer {
	const server = new McpServer(
		{ name: pkg.name, version: pkg.version },
		{ instructions: INSTRUCTIONS },
	);
	registerReadTools(server, mail);
	registerOrganizeTools(server, mail);
	registerComposeTools(server, mail);
	return server;
}
