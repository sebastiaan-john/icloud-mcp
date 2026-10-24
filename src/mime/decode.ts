const utf8 = new TextDecoder();

/** Decodes bytes in a MIME charset, falling back to UTF-8 for unknown labels. */
export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
	try {
		return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
	} catch {
		return utf8.decode(bytes);
	}
}

/** Decodes a body part by its Content-Transfer-Encoding into raw bytes. */
export function decodeTransfer(
	bytes: Uint8Array,
	encoding: string,
): Uint8Array {
	switch (encoding.toLowerCase()) {
		case "base64":
			return Buffer.from(
				Buffer.from(bytes)
					.toString("latin1")
					.replace(/[^A-Za-z0-9+/]/g, ""),
				"base64",
			);
		case "quoted-printable":
			return decodeQuotedPrintable(bytes);
		default:
			return bytes;
	}
}

function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	let n = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (byte !== 0x3d) {
			out[n++] = byte;
			continue;
		}
		// Soft line break: `=` before CRLF or LF, optionally after trailing spaces.
		let j = i + 1;
		while (bytes[j] === 0x20 || bytes[j] === 0x09) j++;
		if (bytes[j] === 0x0d && bytes[j + 1] === 0x0a) {
			i = j + 1;
			continue;
		}
		if (bytes[j] === 0x0a) {
			i = j;
			continue;
		}
		const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
		if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
			out[n++] = Number.parseInt(hex, 16);
			i += 2;
		} else {
			out[n++] = byte;
		}
	}
	return out.subarray(0, n);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded words such as `=?UTF-8?Q?Caf=C3=A9?=`. Adjacent
 * words in the same charset are joined before decoding, so a character split
 * across two words survives. Raw 8-bit header bytes are read as UTF-8.
 */
export function decodeHeader(value: string | Uint8Array): string {
	const raw = typeof value === "string" ? value : utf8.decode(value);
	let out = "";
	let last = 0;
	let run: { charset: string; bytes: number[] } | undefined;
	const flush = () => {
		if (run)
			out += decodeCharset(
				new Uint8Array(run.bytes),
				stripLanguage(run.charset),
			);
		run = undefined;
	};
	for (const match of raw.matchAll(ENCODED_WORD)) {
		const between = raw.slice(last, match.index);
		const [, charset = "", kind = "", payload = ""] = match;
		// Whitespace between two encoded words is folding, not content.
		const adjacent = run !== undefined && /^\s*$/.test(between);
		if (!adjacent || run?.charset !== charset) flush();
		if (!adjacent) out += between;
		run ??= { charset, bytes: [] };
		run.bytes.push(...wordBytes(kind, payload));
		last = match.index + match[0].length;
	}
	flush();
	return (out + raw.slice(last)).replace(/\r?\n[ \t]*/g, " ");
}

function wordBytes(kind: string, payload: string): Uint8Array {
	if (kind.toUpperCase() === "B") return Buffer.from(payload, "base64");
	const qp = payload.replace(/_/g, " ");
	return decodeQuotedPrintable(Buffer.from(qp, "latin1"));
}

/** `UTF-8*nl` (RFC 2231 language suffix) becomes `UTF-8`. */
function stripLanguage(charset: string): string {
	return charset.split("*")[0]!;
}

/**
 * Reads a MIME parameter such as `filename`, handling RFC 2231 extended and
 * continued values (`filename*0*=utf-8''Re%CC%81sume%CC%81;`) and encoded
 * words, which many mailers put in `name`.
 */
export function mimeParam(
	params: Record<string, string>,
	name: string,
): string | undefined {
	const plain = params[name];
	if (plain !== undefined) return decodeHeader(plain);
	const extended = params[`${name}*`];
	if (extended !== undefined) return decode2231(extended);
	const pieces: string[] = [];
	let encoded = false;
	for (let i = 0; ; i++) {
		const piece = params[`${name}*${i}*`] ?? params[`${name}*${i}`];
		if (piece === undefined) break;
		if (params[`${name}*${i}*`] !== undefined && i === 0) encoded = true;
		pieces.push(piece);
	}
	if (pieces.length === 0) return undefined;
	const joined = pieces.join("");
	return encoded ? decode2231(joined) : decodeHeader(joined);
}

function decode2231(value: string): string {
	const match = /^([^']*)'[^']*'(.*)$/s.exec(value);
	const charset = match?.[1] || "utf-8";
	const encoded = match ? match[2]! : value;
	const bytes: number[] = [];
	for (let i = 0; i < encoded.length; i++) {
		const hex = encoded.slice(i + 1, i + 3);
		if (encoded[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(encoded.charCodeAt(i) & 0xff);
		}
	}
	return decodeCharset(new Uint8Array(bytes), charset);
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	bull: "•",
	middot: "·",
	euro: "€",
	pound: "£",
	deg: "°",
	times: "×",
	shy: "",
	zwnj: "",
	zwj: "",
	agrave: "à",
	aacute: "á",
	acirc: "â",
	auml: "ä",
	ccedil: "ç",
	egrave: "è",
	eacute: "é",
	ecirc: "ê",
	euml: "ë",
	iacute: "í",
	iuml: "ï",
	ntilde: "ñ",
	oacute: "ó",
	ocirc: "ô",
	ouml: "ö",
	uacute: "ú",
	uuml: "ü",
	szlig: "ß",
	Auml: "Ä",
	Eacute: "É",
	Ouml: "Ö",
	Uuml: "Ü",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(whole, name: string) => {
			if (name[0] === "#") {
				const code =
					name[1] === "x" || name[1] === "X"
						? Number.parseInt(name.slice(2), 16)
						: Number(name.slice(1));
				return code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: whole;
			}
			return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
		},
	);
}

/**
 * Renders HTML mail as plain text for a model to read: block elements become
 * line breaks, links keep their target as `text (url)`, and head, style,
 * script, and comments are dropped.
 */
export function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(
			/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
			(_, d: string, s: string, b: string, inner: string) => {
				const href = decodeEntities(d ?? s ?? b ?? "").trim();
				const label = inner.replace(/<[^>]*>/g, "").trim();
				if (!label) return "";
				const plainLabel = decodeEntities(label).replace(/\s+/g, " ");
				if (!/^(https?|mailto):/i.test(href) || plainLabel === href)
					return label;
				return `${label} (${href.replace(/^mailto:/i, "")})`;
			},
		)
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(
			/<\/(p|div|tr|table|h[1-6]|ul|ol|blockquote|section|article|header|footer)\s*>/gi,
			"\n",
		)
		.replace(/<(p|div|tr|table|h[1-6]|blockquote)\b[^>]*>/gi, "\n")
		.replace(/<\/t[dh]\s*>/gi, " ")
		.replace(/<[^>]*>/g, "");
	return tidy(decodeEntities(text));
}

/**
 * Normalizes line endings, drops the invisible padding characters that mail
 * preheaders use, collapses runs of spaces, and allows one blank line at most.
 */
export function tidy(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\u034f|[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
