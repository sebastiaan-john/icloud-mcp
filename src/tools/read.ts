import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AttachmentData, Mail } from "../mail";
import { decodeCharset } from "../mime/decode";
import { json, mailboxArg, READ_ONLY, uidArg } from "./common";

const dateArg = (description: string) =>
	z.iso
		.date()
		.transform((day) => new Date(day))
		.optional()
		.describe(description);

const IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const TEXT_TYPES =
	/^(text\/|message\/rfc822$|application\/(json|xml|csv|ics|x-sh|javascript|yaml|x-yaml)$)/;

/** Images come back as image content, text as text, anything else as a base64 resource. */
function attachmentContent(
	mailbox: string,
	uid: number,
	part: string,
	attachment: AttachmentData,
): CallToolResult {
	const { contentType, charset, data, filename } = attachment;
	const label = `${filename ?? `part ${part}`} (${contentType}, ${data.length} bytes)`;
	if (IMAGE_TYPES.has(contentType)) {
		return {
			content: [
				{ type: "text", text: label },
				{
					type: "image",
					data: Buffer.from(data).toString("base64"),
					mimeType: contentType,
				},
			],
		};
	}
	if (TEXT_TYPES.test(contentType)) {
		return {
			content: [
				{ type: "text", text: `${label}\n\n${decodeCharset(data, charset)}` },
			],
		};
	}
	return {
		content: [
			{ type: "text", text: label },
			{
				type: "resource",
				resource: {
					uri: `imap:///${encodeURIComponent(mailbox)};UID=${uid}/;SECTION=${part}`,
					mimeType: contentType,
					blob: Buffer.from(data).toString("base64"),
				},
			},
		],
	};
}

export function registerReadTools(server: McpServer, mail: Mail) {
	server.registerTool(
		"mail_list_mailboxes",
		{
			title: "List mailboxes",
			description:
				"Every mailbox with its message and unread counts. `special_use` marks inbox, sent, drafts, trash, junk, and archive; on iCloud those are named, for example, `Sent Messages` and `Deleted Messages`.",
			annotations: READ_ONLY,
		},
		async () => json({ mailboxes: await mail.listMailboxes() }),
	);

	server.registerTool(
		"mail_search",
		{
			title: "Search mail",
			description:
				"Finds messages in one mailbox, newest first. All filters combine with AND; with none, it lists the newest messages. Returns UIDs with sender, recipients, subject, arrival date, and read, flagged, answered, and attachment state. Use mail_read for the body.",
			inputSchema: z.object({
				mailbox: mailboxArg,
				text: z
					.string()
					.optional()
					.describe("Words anywhere in the headers or body"),
				from: z
					.string()
					.optional()
					.describe("Part of the sender's name or address"),
				to: z
					.string()
					.optional()
					.describe("Part of a recipient's name or address"),
				subject: z.string().optional().describe("Part of the subject"),
				since: dateArg("Arrived on or after this date, YYYY-MM-DD"),
				before: dateArg("Arrived before this date, YYYY-MM-DD"),
				unread: z
					.boolean()
					.optional()
					.describe("true for unread only, false for read only"),
				flagged: z
					.boolean()
					.optional()
					.describe("true for flagged only, false for unflagged only"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(20)
					.describe("Maximum number of messages (1-100)"),
				offset: z
					.number()
					.int()
					.min(0)
					.default(0)
					.describe("Number of newest matches to skip, for paging"),
			}),
			annotations: READ_ONLY,
		},
		async ({ mailbox, limit, offset, ...query }) => {
			const { total, messages } = await mail.search(mailbox, query, {
				offset,
				limit,
			});
			return json({
				mailbox,
				total,
				offset,
				has_more: offset + messages.length < total,
				messages,
			});
		},
	);

	server.registerTool(
		"mail_read",
		{
			title: "Read message",
			description:
				"One message: headers, the body as plain text (HTML is converted, links kept as `text (url)`, hidden text dropped), and its attachments with the `part` to pass to mail_get_attachment. `truncated` means the body was cut. Does not mark the message read.",
			inputSchema: z.object({
				mailbox: mailboxArg,
				uid: uidArg,
				max_chars: z
					.number()
					.int()
					.min(100)
					.max(200_000)
					.default(20_000)
					.describe("Cut the body after this many characters (100-200000)"),
			}),
			annotations: READ_ONLY,
		},
		async ({ mailbox, uid, max_chars }) =>
			json(await mail.read(mailbox, uid, max_chars)),
	);

	server.registerTool(
		"mail_get_attachment",
		{
			title: "Get attachment",
			description:
				"Downloads one attachment, up to 10 MB. Images come back as images, text files as text, and other files such as PDFs as a base64 resource.",
			inputSchema: z.object({
				mailbox: mailboxArg,
				uid: uidArg,
				part: z
					.string()
					.regex(/^\d+(\.\d+)*$/, "A part number such as 2 or 1.2")
					.describe("The attachment's `part` from mail_read, such as 2 or 1.2"),
			}),
			annotations: READ_ONLY,
		},
		async ({ mailbox, uid, part }) =>
			attachmentContent(
				mailbox,
				uid,
				part,
				await mail.attachment(mailbox, uid, part),
			),
	);
}
