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
 * across two words survives. Control characters, a lone CR included, become
 * spaces so a decoded value can never break a header line.
 */
export function decodeHeader(raw: string): string {
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
		// A loop, not push(...bytes): one huge word would overflow the stack.
		for (const byte of wordBytes(kind, payload)) run.bytes.push(byte);
		last = match.index + match[0].length;
	}
	flush();
	return (
		(out + raw.slice(last))
			.replace(/\r?\n[ \t]*/g, " ")
			// oxlint-disable-next-line no-control-regex -- matching control characters is the point
			.replace(/[\x00-\x1f\x7f]/g, " ")
	);
}

function wordBytes(kind: string, payload: string): Uint8Array {
	if (kind.toUpperCase() === "B") return Buffer.from(payload, "base64");
	const qp = payload.replace(/_/g, " ");
	return decodeQuotedPrintable(Buffer.from(qp, "latin1"));
}

/** `UTF-8*nl` (RFC 2231 language suffix) becomes `UTF-8`. */
function stripLanguage(charset: string): string {
	return charset.replace(/\*.*/s, "");
}

/**
 * Reads a MIME parameter such as `filename`. An RFC 2231 extended value
 * (`filename*=utf-8''R%C3%A9sum%C3%A9.pdf`) or continuation
 * (`filename*0*`, `filename*1`, ...) wins over the plain one, which mailers
 * add as an ASCII fallback; encoded words in a plain value are decoded.
 */
export function mimeParam(
	params: Record<string, string>,
	name: string,
): string | undefined {
	const extended = params[`${name}*`];
	if (extended !== undefined) return decode2231([[extended, true]]);
	const pieces: Array<[string, boolean]> = [];
	for (let i = 0; ; i++) {
		const encoded = params[`${name}*${i}*`];
		const piece = encoded ?? params[`${name}*${i}`];
		if (piece === undefined) break;
		pieces.push([piece, encoded !== undefined]);
	}
	if (pieces.length > 0) return decode2231(pieces);
	const plain = params[name];
	return plain === undefined ? undefined : decodeHeader(plain);
}

/**
 * Joins RFC 2231 pieces into bytes: pieces marked encoded are
 * percent-decoded, the rest taken as is, and the first encoded piece names
 * the charset as `charset'language'`.
 */
function decode2231(pieces: Array<[string, boolean]>): string {
	let charset = "utf-8";
	const bytes: number[] = [];
	for (const [index, [piece, encoded]] of pieces.entries()) {
		let value = piece;
		if (encoded && index === 0) {
			const match = /^([^']*)'[^']*'(.*)$/s.exec(piece);
			if (match) {
				charset = match[1] || charset;
				value = match[2] ?? "";
			}
		}
		for (let i = 0; i < value.length; i++) {
			const hex = value.slice(i + 1, i + 3);
			if (encoded && value[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
				bytes.push(Number.parseInt(hex, 16));
				i += 2;
			} else {
				bytes.push(value.charCodeAt(i) & 0xff);
			}
		}
	}
	return decodeCharset(new Uint8Array(bytes), charset);
}

/** A Map, so a name like `constructor` cannot reach Object.prototype. */
const ENTITIES = new Map<string, string>(
	Object.entries({
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
		AMP: "&",
		LT: "<",
		GT: ">",
		QUOT: '"',
		Aacute: "Á",
		Agrave: "À",
		Auml: "Ä",
		Ccedil: "Ç",
		Egrave: "È",
		Ntilde: "Ñ",
		Eacute: "É",
		Ouml: "Ö",
		Uuml: "Ü",
	}),
);

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
			return ENTITIES.get(name) ?? whole;
		},
	);
}

const SKIPPED = new Set(["style", "script", "title", "template"]);
const BLOCKS = new Set([
	"p",
	"div",
	"tr",
	"table",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"blockquote",
	"section",
	"article",
	"header",
	"footer",
	"br",
	"hr",
]);
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Renders HTML mail as plain text for a model to read: block elements become
 * line breaks, links keep their target as `text (url)`, and style, script,
 * title, and comments are dropped. Text hidden with CSS is kept; telling it
 * apart takes a CSS engine, and the plain-text part a sender also controls
 * is read as is anyway.
 *
 * One pass over the input with `indexOf`, so an unclosed tag or comment
 * costs linear time.
 */
export function htmlToText(html: string): string {
	let out = "";
	let i = 0;
	let link: { href: string; start: number } | undefined;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		out += html.slice(i, lt === -1 ? html.length : lt);
		if (lt === -1) break;
		// A `<` that cannot start a tag, as in `a < b`, is text.
		if (!/[a-z/!]/i.test(html[lt + 1] ?? "")) {
			out += "<";
			i = lt + 1;
			continue;
		}
		if (html.startsWith("<!--", lt)) {
			const close = html.indexOf("-->", lt + 4);
			i = close === -1 ? html.length : close + 3;
			continue;
		}
		const gt = html.indexOf(">", lt);
		if (gt === -1) break;
		i = gt + 1;
		const tag = html.slice(lt + 1, gt);
		const match = /^(\/?)([a-z][a-z0-9]*)/i.exec(tag);
		if (!match) continue;
		const closing = match[1] === "/";
		const name = (match[2] ?? "").toLowerCase();
		if (!closing && SKIPPED.has(name)) {
			const end = new RegExp(`</${name}\\s*>`, "gi");
			end.lastIndex = i;
			i = end.exec(html) ? end.lastIndex : html.length;
			continue;
		}
		if (name === "a") {
			if (!closing) {
				const href = HREF.exec(tag);
				const value = href?.[1] ?? href?.[2] ?? href?.[3];
				link =
					value === undefined ? undefined : { href: value, start: out.length };
			} else if (link) {
				const label = decodeEntities(out.slice(link.start)).trim();
				const href = decodeEntities(link.href).trim();
				if (label && label !== href && /^(https?|mailto):/i.test(href)) {
					out += ` (${link.href.trim().replace(/^mailto:/i, "")})`;
				}
				link = undefined;
			}
		} else if (name === "li" && !closing) {
			out += "\n- ";
		} else if ((name === "td" || name === "th") && closing) {
			out += " ";
		} else if (BLOCKS.has(name) && !(closing && name === "li")) {
			out += "\n";
		}
	}
	return tidy(decodeEntities(out));
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
