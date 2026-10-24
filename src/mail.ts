import type { Config } from "./config";
import { errorMessage } from "./errors";
import { ImapCommandError } from "./imap/connection";
import { type ImapClient, type ImapSession, uidSet } from "./imap/session";
import {
	attachments,
	type BodyPart,
	bodyParts,
	decodedSize,
	findPart,
	MESSAGE_ID,
	parseBodyStructure,
	parseEnvelope,
} from "./imap/structure";
import {
	type CommandPart,
	decodeMailbox,
	internalDate,
	pairs,
	quoteMailbox,
	searchDate,
	str,
	text,
	type Value,
} from "./imap/wire";
import { bareAddress, compose, type Outgoing } from "./mime/compose";
import { decodeCharset, decodeTransfer, htmlToText, tidy } from "./mime/decode";
import { sendMail } from "./smtp";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Encoded bytes of body text fetched per message, across all its text parts. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Recipients a reply may have once reply-all has added the original's. */
const MAX_RECIPIENTS = 50;
const SUMMARY_ITEMS = "UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE";

export type SpecialUse =
	| "inbox"
	| "sent"
	| "drafts"
	| "trash"
	| "junk"
	| "archive";

const SPECIAL_USE_FLAGS = new Map<string, SpecialUse>([
	["\\SENT", "sent"],
	["\\DRAFTS", "drafts"],
	["\\TRASH", "trash"],
	["\\JUNK", "junk"],
	["\\ARCHIVE", "archive"],
]);

/** Names to fall back on when the server does not mark special-use mailboxes. */
const SPECIAL_USE_NAMES = new Map<string, SpecialUse>([
	["sent messages", "sent"],
	["sent", "sent"],
	["sent items", "sent"],
	["drafts", "drafts"],
	["deleted messages", "trash"],
	["trash", "trash"],
	["junk", "junk"],
	["spam", "junk"],
	["archive", "archive"],
]);

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
	/** Inclusive, by the date the message arrived. */
	since?: Date;
	/** Exclusive. */
	before?: Date;
	unread?: boolean;
	flagged?: boolean;
}

export interface MessageSummary {
	uid: number;
	date?: string;
	from: string[];
	to: string[];
	subject: string;
	unread: boolean;
	flagged: boolean;
	answered: boolean;
	has_attachments: boolean;
}

export interface Message extends Omit<MessageSummary, "has_attachments"> {
	mailbox: string;
	cc: string[];
	reply_to?: string[];
	message_id?: string;
	in_reply_to?: string;
	text: string;
	/** Set when the body was cut, by `max_chars` or by the fetch limit. */
	truncated?: true;
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
	charset?: string;
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

export interface FlagChange {
	read?: boolean;
	flagged?: boolean;
}

/** The mail operations tools depend on; tests inject fakes. */
export interface Mail {
	listMailboxes(): Promise<MailboxInfo[]>;
	search(
		mailbox: string,
		query: SearchQuery,
		page: { offset: number; limit: number },
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
		change: FlagChange,
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

/** `Mail` over one IMAP session, with SMTP for sending. */
export class ImapMail implements Mail {
	constructor(
		private readonly session: ImapSession,
		private readonly config: Pick<Config, "from" | "smtp">,
		private readonly deliver = sendMail,
	) {}

	listMailboxes(): Promise<MailboxInfo[]> {
		return this.session.run(async (client) => {
			const selectable = (await listAll(client)).filter((m) => m.selectable);
			const { data } = await client.pipeline(
				selectable.map(
					(m) => `STATUS ${quoteMailbox(m.name)} (MESSAGES UNSEEN)`,
				),
			);
			const counts = new Map<string, { messages?: number; unread?: number }>();
			for (const response of data) {
				if (response.type !== "STATUS") continue;
				const [name, list] = response.values;
				const status = pairs(list);
				counts.set(decodeMailbox(text(name) ?? ""), {
					messages: count(status.get("MESSAGES")),
					unread: count(status.get("UNSEEN")),
				});
			}
			return selectable.map((m) => ({
				name: m.name,
				special_use: m.specialUse,
				...counts.get(m.name),
			}));
		});
	}

	search(
		mailbox: string,
		query: SearchQuery,
		{ offset, limit }: { offset: number; limit: number },
	) {
		return this.session.run(async (client) => {
			await client.select(mailbox);
			// UIDs grow with arrival, so the highest are the newest.
			const all = (await client.uidSearch(searchCriteria(query))).toSorted(
				(a, b) => b - a,
			);
			const page = all.slice(offset, offset + limit);
			if (page.length === 0) return { total: all.length, messages: [] };
			const found = await client.uidFetch(page, SUMMARY_ITEMS);
			const messages = page.flatMap((uid) => {
				const items = found.get(uid);
				return items ? [toSummary(items)] : [];
			});
			return { total: all.length, messages };
		});
	}

	read(mailbox: string, uid: number, maxChars: number): Promise<Message> {
		return this.session.run(async (client) => {
			await client.select(mailbox);
			const items = (await client.uidFetch([uid], SUMMARY_ITEMS)).get(uid);
			if (!items) throw notFound(mailbox, uid);
			const structure = parseBodyStructure(items.get("BODYSTRUCTURE"));
			const body = await readBody(client, uid, bodyParts(structure));
			const envelope = parseEnvelope(items.get("ENVELOPE"));
			const { has_attachments: _, ...summary } = toSummary(items);
			const replyTo = envelope.replyTo.filter(
				(a) => !envelope.from.includes(a),
			);
			const truncated = body.cut || body.text.length > maxChars;
			return {
				mailbox,
				...summary,
				cc: envelope.cc,
				reply_to: replyTo.length ? replyTo : undefined,
				message_id: envelope.messageId,
				in_reply_to: envelope.inReplyTo,
				text: body.text.slice(0, maxChars),
				truncated: truncated || undefined,
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
			const head = (await client.uidFetch([uid], "UID BODYSTRUCTURE")).get(uid);
			if (!head) throw notFound(mailbox, uid);
			const found = findPart(
				parseBodyStructure(head.get("BODYSTRUCTURE")),
				part,
			);
			if (!found) {
				throw new Error(
					`Message ${uid} has no part ${part}; mail_read lists the attachment parts.`,
				);
			}
			const tooBig = (bytes: number) =>
				new Error(
					`Part ${part} is about ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
				);
			if (decodedSize(found) > MAX_ATTACHMENT_BYTES) {
				throw tooBig(decodedSize(found));
			}
			const content = await client.uidFetch([uid], `UID BODY.PEEK[${part}]`);
			const raw = sectionBytes(content.get(uid), part);
			const data = decodeTransfer(raw, found.encoding);
			// The size above is an estimate; this is the limit.
			if (data.length > MAX_ATTACHMENT_BYTES) throw tooBig(data.length);
			return {
				filename: found.filename,
				contentType: found.type,
				charset: found.params.charset,
				data,
			};
		});
	}

	setFlags(mailbox: string, uids: number[], change: FlagChange) {
		return this.session.run(async (client) => {
			await client.select(mailbox, true);
			const existing = await client.uidSearch(["UID", uidSet(uids)]);
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

	async move(mailbox: string, uids: number[], to: string) {
		if (mailbox === to) throw new Error(`The messages are already in ${to}.`);
		// Not retried: after a lost reply the messages may already have moved,
		// and the COPY fallback would copy them twice.
		return this.session.run(
			async (client) => {
				await client.select(mailbox, true);
				const existing = await client.uidSearch(["UID", uidSet(uids)]);
				if (existing.length === 0) return [];
				await moveUids(client, uidSet(existing), to);
				return existing;
			},
			{ retry: false },
		);
	}

	async saveDraft(draft: DraftInput) {
		const outgoing = await this.outgoing(draft);
		const { raw, messageId } = compose(outgoing, { includeBcc: true });
		return this.session.run(
			async (client) => {
				const drafts = await specialMailbox(client, "drafts");
				await client.exec([
					"APPEND",
					quoteMailbox(drafts),
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
		const date = new Date();
		const { raw, messageId, recipients } = compose(outgoing, { date });
		if (recipients.length === 0) {
			throw new Error("Add at least one recipient in to, cc, or bcc.");
		}
		// config.ts has already checked that `from` parses.
		const from = bareAddress(this.config.from) ?? this.config.from;
		await this.deliver(this.config.smtp, from, recipients, raw);
		// The archived copy keeps Bcc, which the delivered one must not carry.
		const archived = compose(outgoing, {
			includeBcc: true,
			date,
			messageId,
		}).raw;
		const sentCopy = await this.session
			.run(
				async (client) => {
					const sent = await specialMailbox(client, "sent");
					await client.select(sent);
					const filed = await client.uidSearch([
						"HEADER Message-ID",
						str(messageId),
					]);
					if (filed.length > 0) return `already in ${sent}`;
					await client.exec([
						"APPEND",
						quoteMailbox(sent),
						"(\\Seen)",
						{ literal: archived },
					]);
					return `saved to ${sent}`;
				},
				{ retry: false },
			)
			.catch((error: unknown) => `not saved: ${errorMessage(error)}`);
		if (draft.reply) {
			const { mailbox, uid } = draft.reply;
			// Best effort: the message is sent either way.
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
			const items = (
				await client.uidFetch(
					[reply.uid],
					"UID ENVELOPE BODY.PEEK[HEADER.FIELDS (REFERENCES)]",
				)
			).get(reply.uid);
			if (!items) throw notFound(reply.mailbox, reply.uid);
			let references = "";
			for (const [key, value] of items) {
				if (key.startsWith("BODY[HEADER.FIELDS")) {
					references = text(value) ?? "";
				}
			}
			return { envelope: parseEnvelope(items.get("ENVELOPE")), references };
		});
		const { envelope } = original;
		const self = new Set([
			addressKey(this.config.from),
			addressKey(this.config.smtp.user),
		]);
		// Addresses from the original that would not survive composing are left out.
		const usable = (list: string[]) =>
			list.filter((a) => addressKey(a) !== undefined);
		const answerTo = usable(
			envelope.replyTo.length ? envelope.replyTo : envelope.from,
		);
		// Answering your own message goes to its recipients, as mail clients do.
		const others = answerTo.filter((a) => !self.has(addressKey(a)));
		let to = draft.to;
		if (to.length === 0) to = others.length ? others : usable(envelope.to);
		const taken = new Set([...to, ...draft.cc, ...draft.bcc].map(addressKey));
		const cc = [...draft.cc];
		if (reply.all) {
			for (const address of usable([...envelope.to, ...envelope.cc])) {
				if (self.has(addressKey(address)) || taken.has(addressKey(address)))
					continue;
				taken.add(addressKey(address));
				cc.push(address);
			}
		}
		if (to.length + cc.length + draft.bcc.length > MAX_RECIPIENTS) {
			throw new Error(
				`Replying to everyone would address more than ${MAX_RECIPIENTS} people; list the recipients yourself.`,
			);
		}
		return {
			...base,
			to,
			cc,
			subject:
				draft.subject ??
				(/^re:/i.test(envelope.subject)
					? envelope.subject
					: `Re: ${envelope.subject}`),
			inReplyTo: envelope.messageId,
			references: threadReferences(original.references, envelope),
		};
	}
}

/** An address compared without case; undefined when it does not parse. */
function addressKey(address: string): string | undefined {
	return bareAddress(address)?.toLowerCase();
}

/**
 * The References for a reply: the original's References, or its
 * In-Reply-To when it has none, then its own Message-ID (RFC 5322 3.6.4).
 * A long chain keeps the thread root and the most recent ids.
 */
function threadReferences(
	header: string,
	envelope: { inReplyTo?: string; messageId?: string },
): string[] {
	// Ids may be glued together or followed by comments, so pick out each <...>.
	const ids = (header.match(/<[^<>\s]+>/g) ?? []).filter((id) =>
		MESSAGE_ID.test(id),
	);
	if (ids.length === 0 && envelope.inReplyTo) ids.push(envelope.inReplyTo);
	if (envelope.messageId) ids.push(envelope.messageId);
	return ids.length > 20 ? [...ids.slice(0, 1), ...ids.slice(-19)] : ids;
}

/**
 * Fetches and decodes the text parts within one byte budget. A part past
 * the budget is fetched partially and `cut` reports that something is missing.
 */
async function readBody(
	client: ImapClient,
	uid: number,
	parts: BodyPart[],
): Promise<{ text: string; cut: boolean }> {
	let budget = MAX_TEXT_BYTES;
	let cut = false;
	const sections: Array<[BodyPart, string]> = [];
	for (const part of parts) {
		if (budget <= 0) {
			cut = true;
			break;
		}
		if (part.size > budget) {
			sections.push([part, `BODY.PEEK[${part.part}]<0.${budget}>`]);
			cut = true;
		} else {
			sections.push([part, `BODY.PEEK[${part.part}]`]);
		}
		budget -= part.size;
	}
	if (sections.length === 0) return { text: "", cut };
	const items = (
		await client.uidFetch([uid], `UID ${sections.map(([, s]) => s).join(" ")}`)
	).get(uid);
	const body = sections
		.map(([part]) => decodePart(part, sectionBytes(items, part.part)))
		.filter(Boolean)
		.join("\n\n");
	return { text: body, cut };
}

async function moveUids(
	client: ImapClient,
	set: string,
	to: string,
): Promise<void> {
	try {
		if (client.capabilities.has("MOVE")) {
			await client.exec(["UID MOVE", set, quoteMailbox(to)]);
		} else if (client.capabilities.has("UIDPLUS")) {
			await client.exec(["UID COPY", set, quoteMailbox(to)]);
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
}

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
	if (query.since) keys.push("SINCE", searchDate(query.since));
	if (query.before) keys.push("BEFORE", searchDate(query.before));
	if (query.unread !== undefined) keys.push(query.unread ? "UNSEEN" : "SEEN");
	if (query.flagged !== undefined) {
		keys.push(query.flagged ? "FLAGGED" : "UNFLAGGED");
	}
	if (keys.length === 0) keys.push("ALL");
	const utf8 = keys.some((k) => typeof k !== "string");
	return utf8 ? ["CHARSET", "UTF-8", ...keys] : keys;
}

function count(value: Value | undefined): number | undefined {
	const n = Number(text(value));
	return Number.isInteger(n) ? n : undefined;
}

function flagSet(value: Value | undefined): Set<string> {
	return new Set(
		(Array.isArray(value) ? value : []).map(
			(f) => text(f)?.toUpperCase() ?? "",
		),
	);
}

function toSummary(items: Map<string, Value>): MessageSummary {
	const envelope = parseEnvelope(items.get("ENVELOPE"));
	const flags = flagSet(items.get("FLAGS"));
	return {
		uid: Number(text(items.get("UID"))),
		date: internalDate(items.get("INTERNALDATE")),
		from: envelope.from,
		to: envelope.to,
		subject: envelope.subject,
		unread: !flags.has("\\SEEN"),
		flagged: flags.has("\\FLAGGED"),
		answered: flags.has("\\ANSWERED"),
		has_attachments:
			attachments(parseBodyStructure(items.get("BODYSTRUCTURE"))).length > 0,
	};
}

function sectionBytes(
	items: Map<string, Value> | undefined,
	part: string,
): Uint8Array {
	for (const [key, value] of items ?? []) {
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

function notFound(mailbox: string, uid: number): Error {
	return new Error(
		`No message with UID ${uid} in ${mailbox}. It may have been moved or deleted; search again for current UIDs.`,
	);
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
			const flagged =
				name.toUpperCase() === "INBOX"
					? "inbox"
					: [...attributes].map((a) => SPECIAL_USE_FLAGS.get(a)).find(Boolean);
			return {
				name,
				selectable:
					!attributes.has("\\NOSELECT") && !attributes.has("\\NONEXISTENT"),
				flagged,
			};
		});
	const claimed = new Set(listed.map((m) => m.flagged));
	return listed.map(({ name, selectable, flagged }) => {
		const byName = SPECIAL_USE_NAMES.get(name.toLowerCase());
		const specialUse =
			flagged ?? (byName && !claimed.has(byName) ? byName : undefined);
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
