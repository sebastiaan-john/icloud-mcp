import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DraftInput, Mail } from "../mail";
import { parseAddress } from "../mime/compose";
import { json } from "./common";

const addresses = (description: string) =>
	z
		.array(
			z.string().refine((v) => parseAddress(v) !== undefined, {
				message: "Expected user@host or Name <user@host>",
			}),
		)
		.max(50)
		.default([])
		.describe(description);

const draftSchema = z
	.object({
		to: addresses(
			"Recipients as user@host or Name <user@host>. For a reply, leave empty to answer the sender",
		),
		cc: addresses("Cc recipients"),
		bcc: addresses("Bcc recipients, hidden from the others"),
		subject: z
			.string()
			.regex(/^[^\r\n]*$/, "One line")
			.optional()
			.describe(
				"Subject line. For a reply, leave empty to use Re: and the original subject",
			),
		body: z.string().describe("Plain-text body"),
		reply_to_uid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"UID of the message this answers, for threading and default recipients",
			),
		reply_mailbox: z
			.string()
			.min(1)
			.default("INBOX")
			.describe("Mailbox of reply_to_uid; defaults to INBOX"),
		reply_all: z
			.boolean()
			.default(false)
			.describe("With reply_to_uid, also copy everyone on the original"),
	})
	.refine((a) => a.reply_to_uid !== undefined || a.subject !== undefined, {
		message: "A new message needs a subject",
		path: ["subject"],
	})
	.refine(
		(a) =>
			a.reply_to_uid !== undefined ||
			a.to.length + a.cc.length + a.bcc.length > 0,
		{
			message: "A new message needs at least one recipient",
			path: ["to"],
		},
	);

function toDraft(args: z.output<typeof draftSchema>): DraftInput {
	return {
		to: args.to,
		cc: args.cc,
		bcc: args.bcc,
		subject: args.subject,
		body: args.body,
		reply:
			args.reply_to_uid === undefined
				? undefined
				: {
						mailbox: args.reply_mailbox,
						uid: args.reply_to_uid,
						all: args.reply_all,
					},
	};
}

export function registerComposeTools(server: McpServer, mail: Mail) {
	server.registerTool(
		"mail_save_draft",
		{
			title: "Save draft",
			description:
				"Saves a plain-text message to Drafts without sending it, so the user can review and send it from Mail. Prefer this over mail_send unless the user asked to send. Each call saves another draft.",
			inputSchema: draftSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args) => json(await mail.saveDraft(toDraft(args))),
	);

	server.registerTool(
		"mail_send",
		{
			title: "Send email",
			description:
				"Sends a plain-text email from the user's address right away; it cannot be recalled. Before calling, show the user the recipients, subject, and body and get an explicit yes. A copy goes to Sent. With reply_to_uid it threads as a reply and marks the original answered. Each call sends again.",
			inputSchema: draftSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (args) => json(await mail.send(toDraft(args))),
	);
}
