import type { Config } from "./config";
import { type DataResponse, ImapCommandError } from "./imap/connection";
import type { ImapClient, ImapSession } from "./imap/session";
import {
	attachments,
	type BodyPart,
	bodyParts,
	decodedSize,
	findPart,
	parseBodyStructure,
	parseEnvelope,
} from "./imap/structure";
import {
	type CommandPart,
	decodeMailbox,
	fetchItems,
	mailboxArg,
	searchDate,
	str,
	text,
	type Value,
} from "./imap/wire";
import { bareAddress, compose, type Outgoing } from "./mime/compose";
import { decodeCharset, decodeTransfer, htmlToText, tidy } from "./mime/decode";
import { SmtpError, sendMail } from "./smtp";

export type SpecialUse =
	| "inbox"
	| "sent"
	| "drafts"
	| "trash"
	| "junk"
	| "archive";

export interface MailboxInfo {
	name: string;
	special_use?: SpecialUse;
	messages?: number;
	unread?: number;
}

export interface SearchQuery {
	text?: string;
	from?: string;
	to?: string;
	subject?: string;
	/** `YYYY-MM-DD`, inclusive, by the date the message arrived. */
	since?: string;
	/** `YYYY-MM-DD`, exclusive. */
	before?: string;
	unread?: boolean;
	flagged?: boolean;
}

export interface MessageSummary {
	uid: number;
	date?: string;
	from?: string;
	to: string[];
	subject: string;
	unread: boolean;
	flagged: boolean;
	answered: boolean;
	has_attachments: boolean;
}

export interface Message extends Omit<
	MessageSummary,
	"from" | "has_attachments"
> {
	mailbox: string;
	from: string[];
	cc: string[];
	reply_to?: string[];
	message_id?: string;
	in_reply_to?: string;
	text: string;
	truncated?: { total_chars: number };
	attachments: Array<{
		part: string;
		filename?: string;
		content_type: string;
		size: number;
	}>;
}

export interface AttachmentData {
	filename?: string;
	contentType: string;
	data: Uint8Array;
}

/** What a draft or send call asks for; `reply` points at the message being answered. */
export interface DraftInput {
	to: string[];
	cc: string[];
	bcc: string[];
	subject?: string;
	body: string;
	reply?: { mailbox: string; uid: number; all: boolean };
}

/** The mail operations tools depend on; tests inject fakes. */
export interface Mail {
	listMailboxes(): Promise<MailboxInfo[]>;
	search(
		mailbox: string,
		query: SearchQuery,
		offset: number,
		limit: number,
	): Promise<{ total: number; messages: MessageSummary[] }>;
	read(mailbox: string, uid: number, maxChars: number): Promise<Message>;
	attachment(
		mailbox: string,
		uid: number,
		part: string,
	): Promise<AttachmentData>;
	/** Resolves to the UIDs that existed and were changed. */
	setFlags(
		mailbox: string,
		uids: number[],
		change: { read?: boolean; flagged?: boolean },
	): Promise<number[]>;
	/** Resolves to the UIDs that existed and were moved. */
	move(mailbox: string, uids: number[], to: string): Promise<number[]>;
	saveDraft(
		draft: DraftInput,
	): Promise<{ mailbox: string; message_id: string }>;
	send(draft: DraftInput): Promise<{
		message_id: string;
		recipients: string[];
		sent_copy: string;
	}>;
}

/** Thrown when a send may have gone out even though it failed; tools must not suggest a blind retry. */
export class MaybeSentError extends Error {
	constructor(cause: Error) {
		super(
			`${cause.message}. The message may have been sent anyway; check the Sent mailbox before sending it again.`,
			{ cause },
		);
		this.name = "MaybeSentError";
	}
}

/** Mail over one IMAP session plus SMTP for sending. */
export class ImapMail implements Mail {
	constructor(
		private readonly session: ImapSession,
		private readonly config: Pick<Config, "from" | "smtp">,
		private readonly deliver = sendMail,
	) {}

	listMailboxes(): Promise<MailboxInfo[]> {
		return this.session.run(async (client) => {
			const mailboxes = await listAll(client);
			const selectable = mailboxes.filter((m) => m.selectable);
			const { data } = await client.pipeline(
				selectable.map((m) => `STATUS ${mailboxArg(m.name)} (MESSAGES UNSEEN)`),
			);
			const counts = new Map<string, { messages?: number; unread?: number }>();
			for (const response of data) {
				if (response.type !== "STATUS") continue;
				const [name, list] = response.values;
				const values = Array.isArray(list) ? list : [];
				const entry: { messages?: number; unread?: number } = {};
				for (let i = 0; i + 1 < values.length; i += 2) {
					const key = String(text(values[i])).toUpperCase();
					const n = Number(text(values[i + 1]));
					if (key === "MESSAGES") entry.messages = n;
					if (key === "UNSEEN") entry.unread = n;
				}
				counts.set(decodeMailbox(text(name) ?? ""), entry);
			}
			return selectable.map((m) => ({
				name: m.name,
				special_use: m.specialUse,
				...counts.get(m.name),
			}));
		});
	}

	search(mailbox: string, query: SearchQuery, offset: number, limit: number) {
		return this.session.run(async (client) => {
			await client.select(mailbox);
			const { data } = await client.exec([
				"UID SEARCH",
				...searchCriteria(query),
			]);
			// UIDs grow with arrival, so the highest are the newest.
			const all = searchResults(data).toSorted((a, b) => b - a);
			const page = all.slice(offset, offset + limit);
			if (page.length === 0) return { total: all.length, messages: [] };
			const fetch = await client.exec([
				"UID FETCH",
				uidSet(page),
				"(UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE)",
			]);
			const byUid = fetched(fetch.data);
			const messages = page.flatMap((uid) => {
				const items = byUid.get(uid);
				return items ? [toSummary(items)] : [];
			});
			return { total: all.length, messages };
		});
	}

	read(mailbox: string, uid: number, maxChars: number): Promise<Message> {
		return this.session.run(async (client) => {
			await client.select(mailbox);
			const head = await client.exec([
				"UID FETCH",
				String(uid),
				"(UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE)",
			]);
			const items = fetched(head.data).get(uid);
			if (!items) throw notFound(mailbox, uid);
			const structure = parseBodyStructure(items.get("BODYSTRUCTURE"));
			const parts = bodyParts(structure);
			let body = "";
			if (parts.length > 0) {
				const sections = parts.map((p) =>
					p.size > MAX_TEXT_PART_BYTES
						? `BODY.PEEK[${p.part}]<0.${MAX_TEXT_PART_BYTES}>`
						: `BODY.PEEK[${p.part}]`,
				);
				const content = await client.exec([
					"UID FETCH",
					String(uid),
					`(UID ${sections.join(" ")})`,
				]);
				const bodies = fetched(content.data).get(uid) ?? new Map();
				body = parts
					.map((p) => decodePart(p, sectionBytes(bodies, p.part)))
					.filter(Boolean)
					.join("\n\n");
			}
			const envelope = parseEnvelope(items.get("ENVELOPE"));
			const { date, unread, flagged, answered } = toSummary(items);
			const replyTo = envelope.replyTo.filter(
				(a) => !envelope.from.includes(a),
			);
			return {
				mailbox,
				uid,
				date,
				from: envelope.from,
				to: envelope.to,
				cc: envelope.cc,
				reply_to: replyTo.length ? replyTo : undefined,
				subject: envelope.subject,
				message_id: envelope.messageId,
				in_reply_to: envelope.inReplyTo,
				unread,
				flagged,
				answered,
				text: body.slice(0, maxChars),
				truncated:
					body.length > maxChars ? { total_chars: body.length } : undefined,
				attachments: attachments(structure).map((a) => ({
					part: a.part,
					filename: a.filename,
					content_type: a.type,
					size: decodedSize(a),
				})),
			};
		});
	}

	attachment(mailbox: string, uid: number, part: string) {
		return this.session.run(async (client) => {
			await client.select(mailbox);
			const head = await client.exec([
				"UID FETCH",
				String(uid),
				"(UID BODYSTRUCTURE)",
			]);
			const items = fetched(head.data).get(uid);
			if (!items) throw notFound(mailbox, uid);
			const found = findPart(
				parseBodyStructure(items.get("BODYSTRUCTURE")),
				part,
			);
			if (!found) {
				throw new Error(
					`Message ${uid} has no part ${part}; mail_read lists the attachment parts.`,
				);
			}
			if (decodedSize(found) > MAX_ATTACHMENT_BYTES) {
				throw new Error(
					`Part ${part} is about ${Math.round(decodedSize(found) / 1024 / 1024)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
				);
			}
			const content = await client.exec([
				"UID FETCH",
				String(uid),
				`(UID BODY.PEEK[${part}])`,
			]);
			const raw = sectionBytes(
				fetched(content.data).get(uid) ?? new Map(),
				part,
			);
			return {
				filename: found.filename,
				contentType: found.type,
				data: decodeTransfer(raw, found.encoding),
			};
		});
	}

	setFlags(
		mailbox: string,
		uids: number[],
		change: { read?: boolean; flagged?: boolean },
	) {
		return this.session.run(async (client) => {
			await client.select(mailbox, true);
			const existing = await existingUids(client, uids);
			if (existing.length === 0) return [];
			const set = uidSet(existing);
			for (const [flag, on] of [
				["\\Seen", change.read],
				["\\Flagged", change.flagged],
			] as const) {
				if (on === undefined) continue;
				await client.exec([
					"UID STORE",
					set,
					`${on ? "+" : "-"}FLAGS.SILENT (${flag})`,
				]);
			}
			return existing;
		});
	}

	move(mailbox: string, uids: number[], to: string) {
		return this.session.run(async (client) => {
			if (mailbox === to) throw new Error(`The messages are already in ${to}.`);
			await client.select(mailbox, true);
			const existing = await existingUids(client, uids);
			if (existing.length === 0) return [];
			const set = uidSet(existing);
			try {
				if (client.capabilities.has("MOVE")) {
					await client.exec(["UID MOVE", set, mailboxArg(to)]);
				} else if (client.capabilities.has("UIDPLUS")) {
					await client.exec(["UID COPY", set, mailboxArg(to)]);
					await client.exec(["UID STORE", set, "+FLAGS.SILENT (\\Deleted)"]);
					await client.exec(["UID EXPUNGE", set]);
				} else {
					throw new Error(
						"This IMAP server supports neither MOVE nor UIDPLUS, so messages cannot be moved safely.",
					);
				}
			} catch (error) {
				// TRYCREATE is the server's way of saying the destination does not exist.
				if (
					error instanceof ImapCommandError &&
					error.response.code.toUpperCase().startsWith("TRYCREATE")
				) {
					throw new Error(
						`No mailbox named "${to}". mail_list_mailboxes lists the names.`,
						{ cause: error },
					);
				}
				throw error;
			}
			return existing;
		});
	}

	async saveDraft(draft: DraftInput) {
		const outgoing = await this.outgoing(draft);
		const { raw, messageId } = compose(outgoing, { includeBcc: true });
		return this.session.run(
			async (client) => {
				const drafts = await specialMailbox(client, "drafts");
				await client.exec([
					"APPEND",
					mailboxArg(drafts),
					"(\\Draft \\Seen)",
					{ literal: raw },
				]);
				return { mailbox: drafts, message_id: messageId };
			},
			{ retry: false },
		);
	}

	async send(draft: DraftInput) {
		const outgoing = await this.outgoing(draft);
		const { raw, messageId, recipients } = compose(outgoing);
		if (recipients.length === 0)
			throw new Error("Add at least one recipient in to, cc, or bcc.");
		try {
			await this.deliver(
				this.config.smtp,
				bareAddress(this.config.from),
				recipients,
				raw,
			);
		} catch (error) {
			if (error instanceof SmtpError && error.maybeSent)
				throw new MaybeSentError(error);
			throw error;
		}
		const sentCopy = await this.session
			.run(
				async (client) => {
					const sent = await specialMailbox(client, "sent");
					await client.select(sent);
					const { data } = await client.exec([
						"UID SEARCH HEADER Message-ID",
						str(messageId),
					]);
					if (searchResults(data).length > 0) return `already in ${sent}`;
					await client.exec([
						"APPEND",
						mailboxArg(sent),
						"(\\Seen)",
						{ literal: raw },
					]);
					return `saved to ${sent}`;
				},
				{ retry: false },
			)
			.catch(
				(error: unknown) =>
					`not saved: ${error instanceof Error ? error.message : String(error)}`,
			);
		if (draft.reply) {
			const { mailbox, uid } = draft.reply;
			await this.session
				.run(async (client) => {
					await client.select(mailbox, true);
					await client.exec([
						"UID STORE",
						String(uid),
						"+FLAGS.SILENT (\\Answered)",
					]);
				})
				.catch(() => {});
		}
		return { message_id: messageId, recipients, sent_copy: sentCopy };
	}

	/** Fills in reply headers, recipients, and subject from the original message. */
	private async outgoing(draft: DraftInput): Promise<Outgoing> {
		const base: Outgoing = {
			from: this.config.from,
			to: draft.to,
			cc: draft.cc,
			bcc: draft.bcc,
			subject: draft.subject ?? "",
			body: draft.body,
			references: [],
		};
		const reply = draft.reply;
		if (!reply) return base;
		const original = await this.session.run(async (client) => {
			await client.select(reply.mailbox);
			const { data } = await client.exec([
				"UID FETCH",
				String(reply.uid),
				"(UID ENVELOPE BODY.PEEK[HEADER.FIELDS (REFERENCES)])",
			]);
			const items = fetched(data).get(reply.uid);
			if (!items) throw notFound(reply.mailbox, reply.uid);
			let references = "";
			for (const [key, value] of items) {
				if (key.startsWith("BODY[HEADER.FIELDS"))
					references = text(value) ?? "";
			}
			return { envelope: parseEnvelope(items.get("ENVELOPE")), references };
		});
		const { envelope } = original;
		const self = new Set([
			bareAddress(this.config.from),
			bareAddress(this.config.smtp.user),
		]);
		const answerTo = envelope.replyTo.length ? envelope.replyTo : envelope.from;
		// Answering your own message goes to its recipients, as mail clients do.
		const others = answerTo.filter((a) => !self.has(bareAddress(a)));
		const to = draft.to.length
			? draft.to
			: others.length
				? others
				: envelope.to;
		const taken = new Set([...to, ...draft.bcc].map(bareAddress));
		const cc = [...draft.cc];
		if (reply.all) {
			for (const address of [...envelope.to, ...envelope.cc]) {
				const bare = bareAddress(address);
				if (self.has(bare) || taken.has(bare)) continue;
				taken.add(bare);
				cc.push(address);
			}
		}
		const references = [
			...(original.references.match(/<[^<>\s]+>/g) ?? []),
			...(envelope.messageId ? [envelope.messageId] : []),
		].slice(-20);
		const subject =
			draft.subject ??
			(/^re:/i.test(envelope.subject)
				? envelope.subject
				: `Re: ${envelope.subject}`);
		return {
			...base,
			to,
			cc,
			subject,
			inReplyTo: envelope.messageId,
			references,
		};
	}
}

interface ListedMailbox {
	name: string;
	selectable: boolean;
	specialUse?: SpecialUse;
}

/**
 * Lists every mailbox with its special use: INBOX, then the server's
 * special-use flag, then the usual name for a use no mailbox is flagged for.
 */
async function listAll(client: ImapClient): Promise<ListedMailbox[]> {
	const { data } = await client.exec(["LIST", '""', '"*"']);
	const listed = data
		.filter((d) => d.type === "LIST")
		.map((d) => {
			const [flags, , rawName] = d.values;
			const attributes = flagSet(flags);
			const name = decodeMailbox(text(rawName) ?? "");
			return {
				name,
				selectable:
					!attributes.has("\\NOSELECT") && !attributes.has("\\NONEXISTENT"),
				byFlag:
					name.toUpperCase() === "INBOX"
						? ("inbox" as const)
						: [...attributes].map((a) => SPECIAL_USE_FLAGS[a]).find(Boolean),
			};
		});
	const flagged = new Set(listed.map((m) => m.byFlag));
	return listed.map(({ name, selectable, byFlag }) => {
		const byName = SPECIAL_USE_NAMES[name.toLowerCase()];
		const specialUse =
			byFlag ?? (byName && !flagged.has(byName) ? byName : undefined);
		return { name, selectable, specialUse };
	});
}

/** Finds the mailbox for a special use such as Sent or Drafts. */
async function specialMailbox(
	client: ImapClient,
	use: SpecialUse,
): Promise<string> {
	const found = (await listAll(client)).find(
		(m) => m.selectable && m.specialUse === use,
	);
	if (!found) throw new Error(`No ${use} mailbox found.`);
	return found.name;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Text parts past this size are fetched partially. */
const MAX_TEXT_PART_BYTES = 2 * 1024 * 1024;

const SPECIAL_USE_FLAGS: Record<string, SpecialUse> = {
	"\\SENT": "sent",
	"\\DRAFTS": "drafts",
	"\\TRASH": "trash",
	"\\JUNK": "junk",
	"\\ARCHIVE": "archive",
};

/** Names to fall back on when the server does not mark special-use mailboxes. */
const SPECIAL_USE_NAMES: Record<string, SpecialUse> = {
	inbox: "inbox",
	"sent messages": "sent",
	sent: "sent",
	"sent items": "sent",
	drafts: "drafts",
	"deleted messages": "trash",
	trash: "trash",
	junk: "junk",
	spam: "junk",
	archive: "archive",
};

/**
 * Builds the SEARCH key list. Strings outside printable ASCII go as
 * literals and switch the search to CHARSET UTF-8.
 */
function searchCriteria(query: SearchQuery): CommandPart[] {
	const keys: CommandPart[] = [];
	const add = (key: string, value: string | undefined) => {
		if (value !== undefined && value !== "") keys.push(key, str(value));
	};
	add("TEXT", query.text);
	add("FROM", query.from);
	add("TO", query.to);
	add("SUBJECT", query.subject);
	if (query.since) keys.push("SINCE", searchDate(new Date(query.since)));
	if (query.before) keys.push("BEFORE", searchDate(new Date(query.before)));
	if (query.unread !== undefined) keys.push(query.unread ? "UNSEEN" : "SEEN");
	if (query.flagged !== undefined)
		keys.push(query.flagged ? "FLAGGED" : "UNFLAGGED");
	if (keys.length === 0) keys.push("ALL");
	const utf8 = keys.some((k) => typeof k !== "string");
	return utf8 ? ["CHARSET", "UTF-8", ...keys] : keys;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** `24-Oct-2026 09:15:00 +0200` becomes `2026-10-24T09:15:00+02:00`. */
function internalDate(value: Value | undefined): string | undefined {
	const match =
		/^\s*(\d{1,2})-(\w{3})-(\d{4}) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(
			text(value) ?? "",
		);
	if (!match) return undefined;
	const [, day, month, year, time, zh, zm] = match;
	const m = MONTHS.indexOf(month!) + 1;
	return `${year}-${String(m).padStart(2, "0")}-${day!.padStart(2, "0")}T${time}${zh}:${zm}`;
}

function flagSet(value: Value | undefined): Set<string> {
	return new Set(
		(Array.isArray(value) ? value : []).map((f) =>
			String(text(f)).toUpperCase(),
		),
	);
}

function toSummary(items: Map<string, Value>): MessageSummary {
	const envelope = parseEnvelope(items.get("ENVELOPE"));
	const flags = flagSet(items.get("FLAGS"));
	return {
		uid: Number(text(items.get("UID"))),
		date: internalDate(items.get("INTERNALDATE")),
		from: envelope.from[0],
		to: envelope.to,
		subject: envelope.subject,
		unread: !flags.has("\\SEEN"),
		flagged: flags.has("\\FLAGGED"),
		answered: flags.has("\\ANSWERED"),
		has_attachments:
			attachments(parseBodyStructure(items.get("BODYSTRUCTURE"))).length > 0,
	};
}

/** FETCH responses that carry a UID, keyed by it; unsolicited flag updates without one are skipped. */
function fetched(data: DataResponse[]): Map<number, Map<string, Value>> {
	const byUid = new Map<number, Map<string, Value>>();
	for (const response of data) {
		if (response.type !== "FETCH") continue;
		const items = fetchItems(response.values);
		const uid = Number(text(items.get("UID")));
		if (!Number.isInteger(uid)) continue;
		const merged = byUid.get(uid) ?? new Map<string, Value>();
		for (const [key, value] of items) merged.set(key, value);
		byUid.set(uid, merged);
	}
	return byUid;
}

function sectionBytes(items: Map<string, Value>, part: string): Uint8Array {
	for (const [key, value] of items) {
		if (key === `BODY[${part}]` || key.startsWith(`BODY[${part}]<`)) {
			if (value instanceof Uint8Array) return value;
			return new TextEncoder().encode(text(value) ?? "");
		}
	}
	return new Uint8Array();
}

function decodePart(part: BodyPart, raw: Uint8Array): string {
	const decoded = decodeCharset(
		decodeTransfer(raw, part.encoding),
		part.params.charset,
	);
	return part.type === "text/html" ? htmlToText(decoded) : tidy(decoded);
}

function uidSet(uids: number[]): string {
	return [...new Set(uids)].join(",");
}

async function existingUids(
	client: ImapClient,
	uids: number[],
): Promise<number[]> {
	const { data } = await client.exec(["UID SEARCH UID", uidSet(uids)]);
	return searchResults(data);
}

function searchResults(data: DataResponse[]): number[] {
	return data
		.filter((d) => d.type === "SEARCH")
		.flatMap((d) => d.values.map((v) => Number(text(v))))
		.filter(Number.isInteger);
}

function notFound(mailbox: string, uid: number): Error {
	return new Error(
		`No message with UID ${uid} in ${mailbox}. It may have been moved or deleted; search again for current UIDs.`,
	);
}
