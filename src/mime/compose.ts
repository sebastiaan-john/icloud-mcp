import { randomBytes } from "node:crypto";

/** An outgoing plain-text message. Addresses are `user@host` or `Name <user@host>`. */
export interface Outgoing {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	inReplyTo?: string;
	references: string[];
}

export interface Composed {
	messageId: string;
	/** RFC 5322 bytes with CRLF line endings. */
	raw: Uint8Array;
	/** Envelope recipients for SMTP: To, Cc, and Bcc, deduplicated. */
	recipients: string[];
}

const ADDRESS = /^(?:(.*?)\s*<([^<>\s@]+@[^<>\s@]+)>|([^<>\s@]+@[^<>\s@]+))$/;

/** Splits `Name <user@host>` into its parts; undefined when it is not an address. */
export function parseAddress(
	value: string,
): { name?: string; address: string } | undefined {
	const match = ADDRESS.exec(value.trim());
	if (!match) return undefined;
	const address = match[2] ?? match[3]!;
	const name = match[1]
		?.replace(/^"(.*)"$/, "$1")
		.replace(/\\(.)/g, "$1")
		.trim();
	return { name: name || undefined, address };
}

export function bareAddress(value: string): string {
	return parseAddress(value)?.address.toLowerCase() ?? value.toLowerCase();
}

/**
 * Builds a text/plain UTF-8 message. Bcc is never written as a header unless
 * `includeBcc` is set, which drafts use so the recipient list survives.
 */
export function compose(
	message: Outgoing,
	options: { includeBcc?: boolean; date?: Date } = {},
): Composed {
	const domain =
		parseAddress(message.from)?.address.split("@")[1] ?? "localhost";
	const messageId = `<${randomBytes(16).toString("hex")}@${domain}>`;
	const headers: Array<[string, string]> = [
		["From", addressList([message.from])],
		["Date", formatDate(options.date ?? new Date())],
		["Subject", encodeWords(message.subject)],
		["Message-ID", messageId],
	];
	if (message.to.length) headers.push(["To", addressList(message.to)]);
	if (message.cc.length) headers.push(["Cc", addressList(message.cc)]);
	if (options.includeBcc && message.bcc.length) {
		headers.push(["Bcc", addressList(message.bcc)]);
	}
	if (message.inReplyTo) headers.push(["In-Reply-To", message.inReplyTo]);
	if (message.references.length) {
		headers.push(["References", message.references.join(" ")]);
	}
	headers.push(
		["MIME-Version", "1.0"],
		["Content-Type", "text/plain; charset=utf-8"],
		["Content-Transfer-Encoding", "quoted-printable"],
	);
	const head = headers
		.map(([name, value]) => fold(`${name}: ${value}`))
		.join("\r\n");
	const raw = `${head}\r\n\r\n${encodeQuotedPrintable(message.body)}\r\n`;
	const recipients = [
		...new Set([...message.to, ...message.cc, ...message.bcc].map(bareAddress)),
	];
	return { messageId, raw: new TextEncoder().encode(raw), recipients };
}

function addressList(values: string[]): string {
	return values
		.map((value) => {
			const parsed = parseAddress(value);
			if (!parsed) throw new Error(`Not an email address: ${value}`);
			if (!parsed.name) return parsed.address;
			const name = /^[\x20-\x7e]*$/.test(parsed.name)
				? /[()<>[\]:;@\\,."]/.test(parsed.name)
					? `"${parsed.name.replace(/["\\]/g, "\\$&")}"`
					: parsed.name
				: encodeWords(parsed.name);
			return `${name} <${parsed.address}>`;
		})
		.join(", ");
}

/**
 * Encodes non-ASCII header text as RFC 2047 base64 words, at most 45 bytes
 * of UTF-8 per word so each stays under the 75-character limit.
 */
export function encodeWords(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const encoder = new TextEncoder();
	const words: string[] = [];
	let chunk = "";
	for (const char of value) {
		if (encoder.encode(chunk + char).length > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk) words.push(chunk);
	return words
		.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`)
		.join(" ");
}

/** Folds a header line at spaces so lines stay near 78 characters. */
function fold(line: string): string {
	if (line.length <= 78) return line;
	const out: string[] = [];
	let current = "";
	for (const word of line.split(" ")) {
		if (current && current.length + word.length + 1 > 78) {
			out.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	out.push(current);
	return out.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `Sat, 24 Oct 2026 23:05:09 +0200`, in the local time zone. */
export function formatDate(date: Date): string {
	const days = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
	const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
	return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

/** Quoted-printable over UTF-8, with soft breaks at 76 characters and CRLF line ends. */
export function encodeQuotedPrintable(body: string): string {
	const encoder = new TextEncoder();
	return body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			const bytes = encoder.encode(line);
			const tokens: string[] = [];
			for (const [i, byte] of bytes.entries()) {
				const last = i === bytes.length - 1;
				const literal =
					(byte >= 33 && byte <= 126 && byte !== 61) ||
					((byte === 32 || byte === 9) && !last);
				tokens.push(
					literal
						? String.fromCharCode(byte)
						: `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
				);
			}
			const lines: string[] = [];
			let current = "";
			for (const token of tokens) {
				if (current.length + token.length > 75) {
					lines.push(`${current}=`);
					current = "";
				}
				current += token;
			}
			lines.push(current);
			return lines.join("\r\n");
		})
		.join("\r\n");
}
