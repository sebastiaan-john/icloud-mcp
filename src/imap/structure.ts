import { decodeHeader, mimeParam } from "../mime/decode";
import { text, type Value } from "./wire";

export interface Envelope {
	subject: string;
	from: string[];
	replyTo: string[];
	to: string[];
	cc: string[];
	inReplyTo?: string;
	messageId?: string;
}

/** A leaf or multipart node of a message's MIME tree, as BODYSTRUCTURE describes it. */
export interface BodyPart {
	/** IMAP section number such as `1.2`; empty for the root of a multipart message. */
	part: string;
	/** Lowercase `type/subtype`. */
	type: string;
	params: Record<string, string>;
	encoding: string;
	/** Encoded size in bytes. */
	size: number;
	disposition?: string;
	filename?: string;
	children: BodyPart[];
}

/**
 * One `<id@host>` message id: printable ASCII without spaces or angle
 * brackets, short enough that a reply's header line stays under 998.
 */
export const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;

/** A local part that needs no quoting (RFC 5322 dot-atom). */
const DOT_ATOM =
	/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** Formats an address as `Name <user@host>` or `user@host`. */
function formatAddress(name: string | undefined, address: string): string {
	if (!name || name === address) return address;
	const quoted = /[",<>@;:]/.test(name)
		? `"${name.replace(/["\\]/g, "\\$&")}"`
		: name;
	return `${quoted} <${address}>`;
}

function addresses(value: Value | undefined): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (!Array.isArray(entry)) continue;
		const [name, , mailbox, host] = entry;
		// Group syntax: a NIL host marks the start or end of a group.
		if (host === null || host === undefined) continue;
		// ENVELOPE strips the quotes from a local part such as
		// "service@paypal.com>"; put them back so it cannot pose as an address.
		const local = text(mailbox) ?? "";
		const quoted = DOT_ATOM.test(local)
			? local
			: `"${local.replace(/["\\]/g, "\\$&")}"`;
		const address = `${quoted}@${text(host) ?? ""}`;
		const raw = text(name);
		const display = raw === undefined ? undefined : decodeHeader(raw).trim();
		out.push(formatAddress(display, address));
	}
	return out;
}

export function parseEnvelope(value: Value | undefined): Envelope {
	const v = Array.isArray(value) ? value : [];
	const subject = text(v[1]);
	// Message ids are taken as written, never decoded, and kept only when
	// well formed, since they are copied into the headers of a reply.
	const id = (i: number) => {
		const raw = text(v[i])?.trim();
		return raw && MESSAGE_ID.test(raw) ? raw : undefined;
	};
	return {
		subject: subject === undefined ? "" : decodeHeader(subject),
		from: addresses(v[2]),
		replyTo: addresses(v[4]),
		to: addresses(v[5]),
		cc: addresses(v[6]),
		inReplyTo: id(8),
		messageId: id(9),
	};
}

function paramRecord(value: Value | undefined): Record<string, string> {
	const params: Record<string, string> = {};
	if (!Array.isArray(value)) return params;
	for (let i = 0; i + 1 < value.length; i += 2) {
		const key = text(value[i]);
		const val = text(value[i + 1]);
		if (key !== undefined && val !== undefined) params[key.toLowerCase()] = val;
	}
	return params;
}

/** Parses a BODYSTRUCTURE value into a tree with IMAP section numbers. */
export function parseBodyStructure(
	value: Value | undefined,
	part = "",
): BodyPart {
	const v = Array.isArray(value) ? value : [];
	if (Array.isArray(v[0])) {
		const children: BodyPart[] = [];
		let i = 0;
		while (Array.isArray(v[i])) {
			children.push(
				parseBodyStructure(v[i], part ? `${part}.${i + 1}` : `${i + 1}`),
			);
			i++;
		}
		const subtype = (text(v[i]) ?? "mixed").toLowerCase();
		const { type: dispositionType, params: dispositionParams } = disposition(
			v[i + 2],
		);
		return {
			part,
			type: `multipart/${subtype}`,
			params: paramRecord(v[i + 1]),
			encoding: "7bit",
			size: children.reduce((sum, c) => sum + c.size, 0),
			disposition: dispositionType,
			filename: mimeParam(dispositionParams, "filename")?.trim() || undefined,
			children,
		};
	}
	const type = `${text(v[0]) ?? "text"}/${text(v[1]) ?? "plain"}`.toLowerCase();
	const params = paramRecord(v[2]);
	// Extension data follows the basic fields: lines for text, envelope,
	// body, and lines for message/rfc822, then md5 and disposition.
	let extra = 0;
	if (type.startsWith("text/")) extra = 1;
	if (type === "message/rfc822") extra = 3;
	const { type: dispositionType, params: dispositionParams } = disposition(
		v[7 + extra + 1],
	);
	const filename =
		mimeParam(dispositionParams, "filename") ?? mimeParam(params, "name");
	return {
		part: part || "1",
		type,
		params,
		encoding: (text(v[5]) ?? "7bit").toLowerCase(),
		size: Number(text(v[6]) ?? 0) || 0,
		disposition: dispositionType,
		filename: filename?.trim() || undefined,
		children: [],
	};
}

function disposition(value: Value | undefined) {
	if (!Array.isArray(value)) return { type: undefined, params: {} };
	return {
		type: text(value[0])?.toLowerCase(),
		params: paramRecord(value[1]),
	};
}

/** A file: a filename, an attachment disposition, or a forwarded message. */
function isAttachment(part: BodyPart): boolean {
	return (
		part.disposition === "attachment" ||
		part.filename !== undefined ||
		part.type === "message/rfc822"
	);
}

/**
 * Picks the parts that make up the readable body. In an alternative group
 * the plain text wins over HTML; in a mixed message every inline text part
 * counts, in order.
 */
export function bodyParts(root: BodyPart): BodyPart[] {
	if (root.part !== "" && isAttachment(root)) return [];
	if (root.children.length === 0) {
		return root.type === "text/plain" || root.type === "text/html"
			? [root]
			: [];
	}
	if (root.type === "multipart/alternative") {
		const options = root.children.map((child) => bodyParts(child));
		const plain = options.find((parts) =>
			parts.some((p) => p.type === "text/plain"),
		);
		const html = options.find((parts) =>
			parts.some((p) => p.type === "text/html"),
		);
		return plain ?? html ?? options.find((parts) => parts.length > 0) ?? [];
	}
	return root.children.flatMap((child) => bodyParts(child));
}

/** The files in a message; an attached multipart counts as one file. */
export function attachments(root: BodyPart): BodyPart[] {
	if (root.part !== "" && isAttachment(root)) return [root];
	return root.children.flatMap((child) => attachments(child));
}

export function findPart(root: BodyPart, part: string): BodyPart | undefined {
	if (root.part === part) return root;
	for (const child of root.children) {
		const found = findPart(child, part);
		if (found) return found;
	}
	return undefined;
}

/**
 * Approximate decoded size. Base64 turns 57 bytes into a 76-character line
 * plus CRLF, the line length nearly every mailer uses.
 */
export function decodedSize(part: BodyPart): number {
	return part.encoding === "base64"
		? Math.floor((part.size * 57) / 78)
		: part.size;
}
