import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "bun:test";
import type { AttachmentData, DraftInput, Mail } from "./mail";
import { createServer } from "./server";
import { MaybeSentError } from "./smtp";

function fakeMail(opts: { sendFails?: Error } = {}) {
	const calls = {
		search: [] as unknown[][],
		read: [] as unknown[][],
		flags: [] as unknown[][],
		drafts: [] as DraftInput[],
		sent: [] as DraftInput[],
	};
	const files: Record<string, AttachmentData> = {
		"2": {
			contentType: "application/pdf",
			filename: "factuur.pdf",
			data: new Uint8Array([37, 80, 68, 70]),
		},
		"3": {
			contentType: "image/png",
			filename: "logo.png",
			data: new Uint8Array([137, 80, 78, 71]),
		},
		"4": {
			contentType: "text/csv",
			charset: "windows-1252",
			data: new Uint8Array([99, 97, 102, 233]),
		},
	};
	const mail: Mail = {
		listMailboxes: async () => [
			{ name: "INBOX", special_use: "inbox", messages: 3, unread: 1 },
			{
				name: "Deleted Messages",
				special_use: "trash",
				messages: 0,
				unread: 0,
			},
		],
		search: async (mailbox, query, page) => {
			calls.search.push([mailbox, query, page]);
			return {
				total: 3,
				messages: [
					{
						uid: 7,
						date: "2026-10-24T09:15:00+02:00",
						from: ["Jan <jan@example.nl>"],
						to: ["sebastiaan@icloud.com"],
						subject: "Koffie?",
						unread: true,
						flagged: false,
						answered: false,
						has_attachments: false,
					},
				],
			};
		},
		read: async (mailbox, uid, maxChars) => {
			calls.read.push([mailbox, uid, maxChars]);
			return {
				mailbox,
				uid,
				from: ["Jan <jan@example.nl>"],
				to: [],
				cc: [],
				subject: "Koffie?",
				unread: true,
				flagged: false,
				answered: false,
				text: "Morgen om 10?",
				attachments: [],
			};
		},
		attachment: async (_mailbox, _uid, part) => {
			const file = files[part];
			if (!file) throw new Error(`Message has no part ${part}`);
			return file;
		},
		setFlags: async (mailbox, uids, change) => {
			calls.flags.push([mailbox, uids, change]);
			return uids.filter((uid) => uid < 100);
		},
		move: async (_mailbox, uids) => uids.filter((uid) => uid < 100),
		saveDraft: async (draft) => {
			calls.drafts.push(draft);
			return { mailbox: "Drafts", message_id: "<d@icloud.com>" };
		},
		send: async (draft) => {
			if (opts.sendFails) throw opts.sendFails;
			calls.sent.push(draft);
			return {
				message_id: "<s@icloud.com>",
				recipients: draft.to,
				sent_copy: "saved to Sent Messages",
			};
		},
	};
	return { mail, calls };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) =>
	result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const payload = (result: ToolResult) => JSON.parse(text(result));
const noop = async () => {};

describe("icloud-mcp server", () => {
	let client: Client;
	let close: () => Promise<void> = noop;

	async function connect(mail: Mail) {
		const handler = createMcpHandler(() => createServer(mail));
		const transport = new StreamableHTTPClientTransport(
			new URL("http://test.local/mcp"),
			{
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			},
		);
		client = new Client({ name: "test", version: "0.0.0" });
		await client.connect(transport);
		close = async () => {
			await client.close();
			await handler.close();
		};
		return client;
	}

	afterEach(() => close());

	it("lists every tool with annotations, a description, and a description per argument", async () => {
		await connect(fakeMail().mail);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).toSorted()).toEqual([
			"mail_get_attachment",
			"mail_list_mailboxes",
			"mail_move",
			"mail_read",
			"mail_save_draft",
			"mail_search",
			"mail_send",
			"mail_update_flags",
		]);
		for (const tool of tools) {
			expect(tool.description, tool.name).toBeTruthy();
			expect(tool.annotations?.readOnlyHint, tool.name).toBeBoolean();
			for (const [name, schema] of Object.entries(
				tool.inputSchema.properties ?? {},
			)) {
				const described =
					typeof schema === "object" &&
					schema !== null &&
					"description" in schema;
				expect(described, `${tool.name}.${name}`).toBe(true);
			}
		}
		const byName = new Map(tools.map((t) => [t.name, t]));
		expect(byName.get("mail_send")?.annotations).toMatchObject({
			destructiveHint: true,
			idempotentHint: false,
		});
		expect(byName.get("mail_save_draft")?.annotations?.destructiveHint).toBe(
			false,
		);
		expect(byName.get("mail_search")?.annotations?.readOnlyHint).toBe(true);
	});

	it("searches INBOX by default and reports paging", async () => {
		const { mail, calls } = fakeMail();
		await connect(mail);
		const result = await client.callTool({
			name: "mail_search",
			arguments: { from: "jan", unread: true, limit: 1 },
		});
		expect(calls.search).toEqual([
			["INBOX", { from: "jan", unread: true }, { offset: 0, limit: 1 }],
		]);
		expect(payload(result)).toMatchObject({
			mailbox: "INBOX",
			total: 3,
			offset: 0,
			has_more: true,
			messages: [{ uid: 7, subject: "Koffie?" }],
		});
		for (const since of ["24-10-2026", "2026-02-31"]) {
			const bad = await client.callTool({
				name: "mail_search",
				arguments: { since },
			});
			expect(bad.isError, since).toBe(true);
		}
		await client.callTool({
			name: "mail_search",
			arguments: { since: "2026-10-01" },
		});
		expect(calls.search[1]?.[1]).toEqual({ since: new Date("2026-10-01") });
	});

	it("reads with the default body limit", async () => {
		const { mail, calls } = fakeMail();
		await connect(mail);
		const result = await client.callTool({
			name: "mail_read",
			arguments: { uid: 7 },
		});
		expect(calls.read).toEqual([["INBOX", 7, 20_000]]);
		expect(payload(result).text).toBe("Morgen om 10?");
	});

	it("returns images as images, text as text, and other files as a base64 resource", async () => {
		await connect(fakeMail().mail);
		const get = (part: string) =>
			client.callTool({
				name: "mail_get_attachment",
				arguments: { uid: 7, part },
			});
		const image = await get("3");
		expect(image.content[1]).toEqual({
			type: "image",
			data: "iVBORw==",
			mimeType: "image/png",
		});
		expect(text(await get("4"))).toContain("café");
		const pdf = await get("2");
		expect(pdf.content[1]).toMatchObject({
			type: "resource",
			resource: { mimeType: "application/pdf", blob: "JVBERg==" },
		});
		const injected = await get("1]<0.5> BODY[");
		expect(injected.isError).toBe(true);
	});

	it("needs a flag change and reports UIDs that no longer exist", async () => {
		const { mail, calls } = fakeMail();
		await connect(mail);
		const none = await client.callTool({
			name: "mail_update_flags",
			arguments: { uids: [1] },
		});
		expect(none.isError).toBe(true);
		const result = await client.callTool({
			name: "mail_update_flags",
			arguments: { uids: [1, 500], read: true },
		});
		expect(calls.flags).toEqual([
			["INBOX", [1, 500], { read: true, flagged: undefined }],
		]);
		expect(payload(result)).toEqual({ updated: [1], not_found: [500] });
	});

	it("requires a subject and recipient for new mail but not for replies", async () => {
		const { mail, calls } = fakeMail();
		await connect(mail);
		const missing = await client.callTool({
			name: "mail_send",
			arguments: { body: "hi" },
		});
		expect(missing.isError).toBe(true);
		expect(text(missing)).toContain("subject");
		const injected = await client.callTool({
			name: "mail_save_draft",
			arguments: {
				to: ["a@b.nl"],
				subject: "x\r\nBcc: all@evil.example",
				body: "hi",
			},
		});
		expect(injected.isError).toBe(true);
		const reply = await client.callTool({
			name: "mail_save_draft",
			arguments: { reply_to_uid: 7, reply_all: true, body: "Prima!" },
		});
		expect(reply.isError).toBeFalsy();
		expect(calls.drafts).toEqual([
			{
				to: [],
				cc: [],
				bcc: [],
				subject: undefined,
				body: "Prima!",
				reply: { mailbox: "INBOX", uid: 7, all: true },
			},
		]);
	});

	it("sends with every recipient field and rejects reply_all without a message", async () => {
		const { mail, calls } = fakeMail();
		await connect(mail);
		const orphan = await client.callTool({
			name: "mail_send",
			arguments: { to: ["a@b.nl"], subject: "x", body: "x", reply_all: true },
		});
		expect(orphan.isError).toBe(true);
		const result = await client.callTool({
			name: "mail_send",
			arguments: {
				to: ["Jan <jan@example.nl>"],
				cc: ["piet@x.nl"],
				bcc: ["secret@x.nl"],
				body: "Prima",
				reply_to_uid: 7,
			},
		});
		expect(calls.sent).toEqual([
			{
				to: ["Jan <jan@example.nl>"],
				cc: ["piet@x.nl"],
				bcc: ["secret@x.nl"],
				subject: undefined,
				body: "Prima",
				reply: { mailbox: "INBOX", uid: 7, all: false },
			},
		]);
		expect(payload(result)).toMatchObject({ message_id: "<s@icloud.com>" });
	});

	it("reports moved and missing UIDs", async () => {
		await connect(fakeMail().mail);
		const result = await client.callTool({
			name: "mail_move",
			arguments: { uids: [3, 500], to: "Deleted Messages" },
		});
		expect(payload(result)).toEqual({
			moved: [3],
			to: "Deleted Messages",
			not_found: [500],
		});
	});

	it("warns against resending when a send may have gone through", async () => {
		const failure = new MaybeSentError(new Error("SMTP connection closed"));
		await connect(fakeMail({ sendFails: failure }).mail);
		const result = await client.callTool({
			name: "mail_send",
			arguments: { to: ["jan@example.nl"], subject: "Hoi", body: "hi" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(
			"check the Sent mailbox before sending it again",
		);
	});
});
