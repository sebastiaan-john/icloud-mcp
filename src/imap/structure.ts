import { decodeHeader, mimeParam } from "../mime/decode";
import { text, type Value } from "./wire";

export interface Envelope {
	date?: string;
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

/** Formats an address as `Name <user@host>` or `user@host`. */
export function formatAddress(
	name: string | undefined,
	address: string,
): string {
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
		const address = `${text(mailbox) ?? ""}@${text(host) ?? ""}`;
		const display =
			name === null || name === undefined
				? undefined
				: decodeHeader(text(name)!);
		out.push(formatAddress(display?.trim(), address));
	}
	return out;
}

export function parseEnvelope(value: Value | undefined): Envelope {
	const v = Array.isArray(value) ? value : [];
	const header = (i: number) => {
		const raw = v[i];
		return raw === null || raw === undefined
			? undefined
			: decodeHeader(text(raw)!);
	};
	return {
		date: header(0),
		subject: header(1) ?? "",
		from: addresses(v[2]),
		replyTo: addresses(v[4]),
		to: addresses(v[5]),
		cc: addresses(v[6]),
		inReplyTo: header(8)?.trim() || undefined,
		messageId: header(9)?.trim() || undefined,
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
		const dispositionValue = v[i + 2];
		return {
			part,
			type: `multipart/${subtype}`,
			params: paramRecord(v[i + 1]),
			encoding: "7bit",
			size: children.reduce((sum, c) => sum + c.size, 0),
			disposition: disposition(dispositionValue).type,
			children,
		};
	}
	const type = `${text(v[0]) ?? "text"}/${text(v[1]) ?? "plain"}`.toLowerCase();
	const params = paramRecord(v[2]);
	// Extension data follows the basic fields: lines for text, envelope,
	// body, and lines for message/rfc822, then md5 and disposition.
	const extra = type.startsWith("text/")
		? 1
		: type === "message/rfc822"
			? 3
			: 0;
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
	if (root.children.length === 0) {
		const readable = root.type === "text/plain" || root.type === "text/html";
		return readable && !isAttachment(root) ? [root] : [];
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

/** Leaves that are files: a filename, an attachment disposition, or a forwarded message. */
export function attachments(root: BodyPart): BodyPart[] {
	if (root.children.length === 0) return isAttachment(root) ? [root] : [];
	return root.children.flatMap((child) => attachments(child));
}

export function findPart(root: BodyPart, part: string): BodyPart | undefined {
	if (root.part === part && root.children.length === 0) return root;
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
