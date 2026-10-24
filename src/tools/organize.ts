import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Mail } from "../mail";
import { IDEMPOTENT_WRITE, json, mailboxArg, uidsArg } from "./common";

function missing(requested: number[], found: number[]): number[] | undefined {
	const present = new Set(found);
	const gone = requested.filter((uid) => !present.has(uid));
	return gone.length ? gone : undefined;
}

export function registerOrganizeTools(server: McpServer, mail: Mail) {
	server.registerTool(
		"mail_update_flags",
		{
			title: "Mark read, unread, or flagged",
			description:
				"Marks messages read or unread and flags or unflags them. Returns the UIDs it changed and any that no longer exist.",
			inputSchema: z
				.object({
					mailbox: mailboxArg,
					uids: uidsArg,
					read: z
						.boolean()
						.optional()
						.describe("true marks read, false marks unread"),
					flagged: z
						.boolean()
						.optional()
						.describe("true flags, false removes the flag"),
				})
				.refine((a) => a.read !== undefined || a.flagged !== undefined, {
					message: "Set read, flagged, or both",
				}),
			annotations: IDEMPOTENT_WRITE,
		},
		async ({ mailbox, uids, read, flagged }) => {
			const updated = await mail.setFlags(mailbox, uids, { read, flagged });
			return json({ updated, not_found: missing(uids, updated) });
		},
	);

	server.registerTool(
		"mail_move",
		{
			title: "Move messages",
			description:
				"Moves messages to another mailbox. To delete, move them to the mailbox whose special_use is trash; to archive, to the archive mailbox. Moved messages get new UIDs in the destination, so search there to act on them again.",
			inputSchema: z.object({
				mailbox: mailboxArg,
				uids: uidsArg,
				to: z
					.string()
					.min(1)
					.describe(
						"Destination mailbox name as mail_list_mailboxes returns it",
					),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ mailbox, uids, to }) => {
			const moved = await mail.move(mailbox, uids, to);
			return json({ moved, to, not_found: missing(uids, moved) });
		},
	);
}
