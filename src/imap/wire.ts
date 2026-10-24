/**
 * A parsed IMAP value: atoms and quoted strings become strings, literals stay
 * bytes (message bodies may be in any charset), NIL becomes null, and
 * parenthesized lists become arrays.
 */
export type Value = string | Uint8Array | null | Value[];

export type Response =
	| { kind: "continuation"; text: string }
	| {
			kind: "status";
			tag: string;
			status: "OK" | "NO" | "BAD" | "BYE" | "PREAUTH";
			/** The bracketed response code without brackets, such as `APPENDUID 1 5`. */
			code: string;
			text: string;
	  }
	| {
			kind: "data";
			/** `FETCH`, `LIST`, `SEARCH`, `EXISTS`, and so on, uppercased. */
			type: string;
			/** The number before the type in `* 12 FETCH (...)`. */
			number?: number;
			values: Value[];
	  };

/** A command argument sent as a literal: bytes the server reads by length. */
export interface Literal {
	literal: Uint8Array;
}
export type CommandPart = string | Literal;

const CR = 13;
const LF = 10;
const SP = 32;
const encoder = new TextEncoder();
const utf8 = new TextDecoder();
const STATUSES = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);

/**
 * Splits a byte stream into complete responses. A response ends at a CRLF
 * that is not followed by a literal announced as `{n}` right before it.
 */
export class ResponseFramer {
	private buffer = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	/** Where to look for the next CRLF; past any literal already framed. */
	private scan = 0;

	push(chunk: Uint8Array): Uint8Array[] {
		this.append(chunk);
		const responses: Uint8Array[] = [];
		while (this.scan < this.end) {
			const lf = this.buffer.indexOf(LF, this.scan);
			if (lf === -1 || lf >= this.end) {
				this.scan = this.end;
				break;
			}
			const literal = literalLength(this.buffer, this.start, lf);
			if (literal !== undefined) {
				this.scan = lf + 1 + literal;
				continue;
			}
			responses.push(this.buffer.slice(this.start, lf + 1));
			this.start = lf + 1;
			this.scan = this.start;
		}
		return responses;
	}

	/** Appends without copying the whole buffer per chunk, so a large literal stays linear. */
	private append(chunk: Uint8Array): void {
		if (this.end + chunk.length > this.buffer.length) {
			const live = this.end - this.start;
			if (live + chunk.length > this.buffer.length) {
				const next = new Uint8Array((live + chunk.length) * 2);
				next.set(this.buffer.subarray(this.start, this.end));
				this.buffer = next;
			} else {
				this.buffer.copyWithin(0, this.start, this.end);
			}
			this.scan -= this.start;
			this.end = live;
			this.start = 0;
		}
		this.buffer.set(chunk, this.end);
		this.end += chunk.length;
	}
}

/** The length of a `{n}` or `{n+}` literal announced right before the line feed at `lf`. */
function literalLength(
	bytes: Uint8Array,
	lineStart: number,
	lf: number,
): number | undefined {
	let i = lf - 1;
	if (bytes[i] === CR) i--;
	if (bytes[i] !== 0x7d) return undefined; // }
	i--;
	if (bytes[i] === 0x2b) i--; // + (LITERAL+)
	let digits = "";
	while (i >= lineStart && bytes[i]! >= 0x30 && bytes[i]! <= 0x39) {
		digits = String.fromCharCode(bytes[i]!) + digits;
		i--;
	}
	if (digits === "" || bytes[i] !== 0x7b) return undefined; // {
	return Number(digits);
}

/** Parses one complete response as produced by ResponseFramer. */
export function parseResponse(bytes: Uint8Array): Response {
	const reader = new Reader(bytes);
	const tag = reader.word();
	if (tag === "+") {
		return { kind: "continuation", text: reader.rest() };
	}
	let word = reader.word();
	let number: number | undefined;
	if (tag === "*" && /^\d+$/.test(word)) {
		number = Number(word);
		word = reader.word();
	}
	const upper = word.toUpperCase();
	if (number === undefined && STATUSES.has(upper)) {
		return {
			kind: "status",
			tag,
			status: upper as "OK" | "NO" | "BAD" | "BYE" | "PREAUTH",
			code: reader.code(),
			text: reader.rest(),
		};
	}
	return { kind: "data", type: upper, number, values: reader.values() };
}

class Reader {
	private pos = 0;
	constructor(private readonly bytes: Uint8Array) {}

	/** Reads up to the next space, without tokenizing. */
	word(): string {
		const start = this.pos;
		while (this.pos < this.bytes.length && !isLineEnd(this.bytes[this.pos]!)) {
			if (this.bytes[this.pos] === SP) break;
			this.pos++;
		}
		const word = utf8.decode(this.bytes.subarray(start, this.pos));
		if (this.bytes[this.pos] === SP) this.pos++;
		return word;
	}

	code(): string {
		if (this.bytes[this.pos] !== 0x5b) return ""; // [
		const close = this.bytes.indexOf(0x5d, this.pos); // ]
		if (close === -1) return "";
		const code = utf8.decode(this.bytes.subarray(this.pos + 1, close));
		this.pos = close + 1;
		if (this.bytes[this.pos] === SP) this.pos++;
		return code;
	}

	rest(): string {
		return utf8.decode(this.bytes.subarray(this.pos)).replace(/\r?\n$/, "");
	}

	values(): Value[] {
		const values: Value[] = [];
		for (;;) {
			this.skipSpaces();
			if (this.pos >= this.bytes.length || isLineEnd(this.bytes[this.pos]!)) {
				return values;
			}
			values.push(this.value());
		}
	}

	private value(): Value {
		const byte = this.bytes[this.pos];
		if (byte === 0x28) return this.list(); // (
		if (byte === 0x22) return this.quoted(); // "
		if (byte === 0x7b || (byte === 0x7e && this.bytes[this.pos + 1] === 0x7b)) {
			return this.literal(); // { or ~{
		}
		const atom = this.atom();
		return atom.toUpperCase() === "NIL" ? null : atom;
	}

	private list(): Value[] {
		this.pos++;
		const items: Value[] = [];
		for (;;) {
			this.skipSpaces();
			const byte = this.bytes[this.pos];
			if (byte === undefined || isLineEnd(byte)) {
				throw new Error("IMAP response ended inside a list");
			}
			if (byte === 0x29) {
				this.pos++;
				return items;
			}
			items.push(this.value());
		}
	}

	private quoted(): string {
		this.pos++;
		const out: number[] = [];
		for (;;) {
			const byte = this.bytes[this.pos++];
			if (byte === undefined) throw new Error("Unterminated IMAP string");
			if (byte === 0x22) break;
			if (byte === 0x5c) {
				out.push(this.bytes[this.pos++]!);
				continue;
			}
			out.push(byte);
		}
		return utf8.decode(new Uint8Array(out));
	}

	private literal(): Uint8Array {
		if (this.bytes[this.pos] === 0x7e) this.pos++;
		const lf = this.bytes.indexOf(LF, this.pos);
		const header = utf8.decode(this.bytes.subarray(this.pos, lf));
		const length = Number(/^\{(\d+)\+?\}/.exec(header)?.[1]);
		if (!Number.isFinite(length)) throw new Error("Malformed IMAP literal");
		const start = lf + 1;
		this.pos = start + length;
		return this.bytes.slice(start, this.pos);
	}

	/**
	 * Reads an atom. Brackets are part of it, spaces and parens included, so
	 * `BODY[HEADER.FIELDS (REFERENCES)]<0>` stays one token.
	 */
	private atom(): string {
		const start = this.pos;
		let depth = 0;
		while (this.pos < this.bytes.length) {
			const byte = this.bytes[this.pos]!;
			if (byte === 0x5b) depth++;
			else if (byte === 0x5d) depth--;
			else if (depth === 0 && (byte === SP || byte === 0x28 || byte === 0x29)) {
				break;
			} else if (isLineEnd(byte)) break;
			this.pos++;
		}
		if (this.pos === start) {
			throw new Error(
				`Unexpected byte ${this.bytes[this.pos]} in IMAP response`,
			);
		}
		return utf8.decode(this.bytes.subarray(start, this.pos));
	}

	private skipSpaces(): void {
		while (this.bytes[this.pos] === SP) this.pos++;
	}
}

function isLineEnd(byte: number): boolean {
	return byte === CR || byte === LF;
}

/**
 * Encodes a string argument: a quoted string when it is plain ASCII, a
 * literal otherwise, since quoted strings cannot carry CR, LF, or 8-bit bytes.
 */
export function str(value: string): CommandPart {
	if (/^[\x20-\x7e]*$/.test(value)) {
		return `"${value.replace(/["\\]/g, "\\$&")}"`;
	}
	return { literal: encoder.encode(value) };
}

/**
 * Encodes a mailbox name argument in modified UTF-7 (RFC 3501 5.1.3), which
 * is always printable ASCII and so always fits a quoted string.
 */
export function mailboxArg(name: string): string {
	return `"${encodeMailbox(name).replace(/["\\]/g, "\\$&")}"`;
}

/** Formats a date for SEARCH SINCE/BEFORE, e.g. `24-Oct-2026`. */
export function searchDate(date: Date): string {
	const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
	return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** Decodes a modified UTF-7 mailbox name such as `Verzonden &AOk-` into Unicode. */
export function decodeMailbox(name: string): string {
	return name.replace(/&([^-]*)-/g, (_, chunk: string) => {
		if (chunk === "") return "&";
		const bytes = Buffer.from(chunk.replace(/,/g, "/"), "base64");
		let out = "";
		for (let i = 0; i + 1 < bytes.length; i += 2) {
			out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
		}
		return out;
	});
}

export function encodeMailbox(name: string): string {
	return name.replace(/&|[^\x20-\x7e]+/g, (run) => {
		if (run === "&") return "&-";
		const bytes = Buffer.alloc(run.length * 2);
		for (let i = 0; i < run.length; i++) {
			bytes.writeUInt16BE(run.charCodeAt(i), i * 2);
		}
		return `&${bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
	});
}

/** Reads a string-ish value as text; literals decode as UTF-8. */
export function text(value: Value | undefined): string | undefined {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return utf8.decode(value);
	return undefined;
}

/**
 * Turns a FETCH value list `(UID 5 FLAGS (\Seen) BODY[1] {3}...)` into a map
 * keyed by uppercased item name.
 */
export function fetchItems(values: Value[]): Map<string, Value> {
	const items = new Map<string, Value>();
	const list = values[0];
	if (!Array.isArray(list)) return items;
	for (let i = 0; i + 1 < list.length; i += 2) {
		const key = list[i];
		if (typeof key === "string") items.set(key.toUpperCase(), list[i + 1]!);
	}
	return items;
}
