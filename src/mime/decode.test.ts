import { describe, expect, it } from "bun:test";
import {
	decodeCharset,
	decodeHeader,
	decodeTransfer,
	htmlToText,
	mimeParam,
} from "./decode";

const latin1 = (s: string) => Buffer.from(s, "latin1");

describe("decodeHeader", () => {
	it("decodes B and Q words, joins a character split across words, and keeps plain text", () => {
		expect(decodeHeader("=?UTF-8?Q?Ren=C3?= =?UTF-8?Q?=A9e?= <r@x.fr>")).toBe(
			"Renée <r@x.fr>",
		);
		expect(decodeHeader("Re: =?iso-8859-1?q?caf=E9_au_lait?= now")).toBe(
			"Re: café au lait now",
		);
		expect(
			decodeHeader("=?UTF-8?B?w6lsw6k=?=\r\n =?UTF-8?B?Z2FudA==?= and plain"),
		).toBe("élégant and plain");
		expect(decodeHeader("=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=")).toBe(
			"こんにちは",
		);
		expect(decodeHeader("Plain subject")).toBe("Plain subject");
	});

	it("decodes one huge encoded word without overflowing the stack", () => {
		const word = Buffer.from("x".repeat(1_200_000)).toString("base64");
		expect(decodeHeader(`=?UTF-8?B?${word}?=`)).toHaveLength(1_200_000);
	});

	it("turns decoded control characters, a lone CR included, into spaces", () => {
		expect(decodeHeader("=?UTF-8?Q?<a@b>=0DBcc:_x@y?=")).toBe("<a@b> Bcc: x@y");
	});
});

describe("mimeParam", () => {
	it("handles RFC 2231 extended, continued, and encoded-word parameters", () => {
		expect(
			mimeParam({ "filename*": "UTF-8''R%C3%A9sum%C3%A9.pdf" }, "filename"),
		).toBe("Résumé.pdf");
		expect(
			mimeParam(
				{ "filename*0*": "utf-8''Factuur%20", "filename*1": "oktober.pdf" },
				"filename",
			),
		).toBe("Factuur oktober.pdf");
		expect(mimeParam({ name: "=?UTF-8?B?bG9nby5wbmc=?=" }, "name")).toBe(
			"logo.png",
		);
		expect(mimeParam({}, "filename")).toBeUndefined();
		// Only pieces marked with * are percent-decoded.
		expect(
			mimeParam(
				{ "filename*0*": "utf-8''a%20b", "filename*1": "%41.txt" },
				"filename",
			),
		).toBe("a b%41.txt");
		expect(
			mimeParam(
				{ filename: "resume.pdf", "filename*": "utf-8''r%C3%A9sum%C3%A9.pdf" },
				"filename",
			),
		).toBe("résumé.pdf");
	});
});

describe("decodeTransfer and decodeCharset", () => {
	it("decodes quoted-printable soft breaks and escapes", () => {
		const qp = latin1("caf=C3=A9 =\r\nop de hoek=3D ok=\nend");
		expect(decodeCharset(decodeTransfer(qp, "quoted-printable"))).toBe(
			"café op de hoek= okend",
		);
	});

	it("decodes base64 with line breaks", () => {
		expect(
			decodeCharset(decodeTransfer(latin1("w6l\r\nsw6k="), "BASE64")),
		).toBe("élé");
	});

	it("decodes legacy charsets and falls back to UTF-8 for unknown labels", () => {
		expect(decodeCharset(latin1("caf\xe9 \x80"), "windows-1252")).toBe(
			"café €",
		);
		expect(decodeCharset(new TextEncoder().encode("ok é"), "x-unknown")).toBe(
			"ok é",
		);
	});
});

describe("htmlToText", () => {
	it("keeps text and links, drops head, style, script, and comments, and lists items", () => {
		const html = `<html><head><title>T</title><style>p{}</style></head><body>
			<!-- hidden --><h1>Caf&eacute; &amp; co</h1>
			<p>Prijs: &euro;9,99&nbsp;&mdash; <a href="https://shop.example/deal?a=1&amp;b=2">korting</a>,
			<a href="https://x.example">https://x.example</a> <a href="https://t.example"><img src="p.gif"></a></p>
			<ul><li>E&#233;n</li><li>Twee</li></ul><table><tr><td>A</td><td>B</td></tr></table>
			<script>alert(1)</script></body></html>`;
		expect(htmlToText(html)).toBe(
			"Café & co\n\nPrijs: €9,99 — korting (https://shop.example/deal?a=1&b=2),\nhttps://x.example\n\n- Eén\n- Twee\n\nA B",
		);
	});

	it("keeps content in elements whose attributes mention hidden, and text after an unclosed head", () => {
		const html = `<html><head><meta charset="utf-8"><body>
			<div style="max-width:600px;overflow:hidden"><p>Order 1234 shipped</p></div>
			<span aria-hidden="true">★</span><div class="hidden-xs">Desktop offer</div>
			<p>If a < b then <b>bold</b><?xml:namespace prefix = o /><o:p></o:p></p></body></html>`;
		expect(htmlToText(html)).toBe(
			"Order 1234 shipped\n\n★\nDesktop offer\n\nIf a < b then bold",
		);
	});

	it("keeps entity case and never resolves a name through Object.prototype", () => {
		expect(htmlToText("&Aacute;gua &amp; &AMP; &constructor; &Bogus;")).toBe(
			"Água & & &constructor; &Bogus;",
		);
	});

	it("stays linear on unclosed anchors, comments, and style blocks", () => {
		const hostile = `${'<a href="https://x.example">'.repeat(10_000)}<!-- ${"x".repeat(10_000)} <style>${"y".repeat(10_000)}`;
		expect(htmlToText(`ok ${hostile}`)).toBe("ok");
		expect(htmlToText(`${"<a ".repeat(100_000)}tail`)).toBe("");
	});
});
