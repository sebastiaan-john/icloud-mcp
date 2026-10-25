import { describe, expect, it } from "bun:test";
import {
	attachments,
	bodyParts,
	decodedSize,
	findPart,
	parseBodyStructure,
	parseEnvelope,
} from "./structure";
import { pairs, parseResponse } from "./wire";

/** Parses one FETCH line the way the connection would. */
function fetchLine(line: string) {
	const response = parseResponse(new TextEncoder().encode(`${line}\r\n`));
	if (response.kind !== "data") throw new Error("expected data");
	return pairs(response.values[0]);
}

// Dovecot's answer for a mixed message: alternative (plain, html), a PDF with
// an RFC 2231 filename, and an inline PNG whose name is an encoded word.
const MIXED = fetchLine(
	`* 4 FETCH (UID 4 BODYSTRUCTURE ((("text" "plain" ("charset" "utf-8") NIL NIL "base64" 58 1 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "7bit" 29 1 NIL NIL NIL NIL) "alternative" ("boundary" "a1") NIL NIL NIL)("application" "pdf" ("name" "factuur.pdf") NIL NIL "base64" 62 NIL ("attachment" ("filename*" "UTF-8''Factuur%20%E2%82%AC12.pdf")) NIL NIL)("image" "png" ("name" "=?UTF-8?B?bG9nb19ibGF1dy5wbmc=?=") NIL NIL "base64" 98 NIL ("inline" NIL) NIL NIL)("message" "rfc822" NIL NIL NIL "7bit" 144 (NIL "Planning" NIL NIL NIL NIL NIL NIL NIL NIL) ("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 32 1 NIL NIL NIL NIL) 6 NIL NIL NIL NIL) "mixed" ("boundary" "m1") NIL NIL NIL))`,
);

describe("parseBodyStructure", () => {
	const root = parseBodyStructure(MIXED.get("BODYSTRUCTURE"));

	it("numbers parts and reads types, encodings, and filenames", () => {
		expect(root.type).toBe("multipart/mixed");
		expect(root.children.map((c) => [c.part, c.type])).toEqual([
			["1", "multipart/alternative"],
			["2", "application/pdf"],
			["3", "image/png"],
			["4", "message/rfc822"],
		]);
		expect(findPart(root, "1.1")).toMatchObject({
			type: "text/plain",
			encoding: "base64",
			params: { charset: "utf-8" },
		});
		expect(findPart(root, "2")?.filename).toBe("Factuur €12.pdf");
		expect(findPart(root, "3")?.filename).toBe("logo_blauw.png");
	});

	it("reads the plain alternative as the body and lists files and forwarded mail as attachments", () => {
		expect(bodyParts(root).map((p) => p.part)).toEqual(["1.1"]);
		expect(attachments(root).map((p) => p.part)).toEqual(["2", "3", "4"]);
	});

	it("falls back to HTML when an alternative has no plain part", () => {
		const htmlOnly = parseBodyStructure(
			fetchLine(
				`* 1 FETCH (BODYSTRUCTURE ((("text" "html" ("charset" "utf-8") NIL NIL "7bit" 10 1 NIL NIL NIL NIL)("image" "gif" NIL "<logo>" NIL "base64" 40 NIL NIL NIL NIL) "related" NIL NIL NIL NIL)("text" "calendar" NIL NIL NIL "7bit" 5 1 NIL NIL NIL NIL) "alternative" NIL NIL NIL NIL))`,
			).get("BODYSTRUCTURE"),
		);
		expect(bodyParts(htmlOnly).map((p) => p.part)).toEqual(["1.1"]);
		expect(attachments(htmlOnly)).toEqual([]);
	});

	it("lists an attached multipart as one file and keeps its text out of the body", () => {
		const bundle = parseBodyStructure(
			fetchLine(
				`* 1 FETCH (BODYSTRUCTURE (("text" "plain" NIL NIL NIL "7bit" 3 1 NIL NIL NIL NIL)(("text" "plain" NIL NIL NIL "7bit" 9 1 NIL NIL NIL NIL)("image" "png" NIL NIL NIL "base64" 40 NIL NIL NIL NIL) "related" NIL ("attachment" ("filename" "bundle.mime")) NIL NIL) "mixed" NIL NIL NIL NIL))`,
			).get("BODYSTRUCTURE"),
		);
		expect(bodyParts(bundle).map((p) => p.part)).toEqual(["1"]);
		expect(attachments(bundle)).toMatchObject([
			{ part: "2", type: "multipart/related", filename: "bundle.mime" },
		]);
		expect(findPart(bundle, "2")?.type).toBe("multipart/related");
	});

	it("numbers a single-part message as part 1", () => {
		const single = parseBodyStructure(
			fetchLine(
				`* 1 FETCH (BODYSTRUCTURE ("text" "plain" ("charset" "iso-8859-1") NIL NIL "quoted-printable" 20 2 NIL NIL NIL NIL))`,
			).get("BODYSTRUCTURE"),
		);
		expect(bodyParts(single).map((p) => p.part)).toEqual(["1"]);
	});

	it("estimates the decoded size of wrapped base64", () => {
		// 57 bytes per 76-character line plus CRLF.
		expect(decodedSize({ ...root, encoding: "base64", size: 78 * 100 })).toBe(
			5700,
		);
	});
});

describe("parseEnvelope", () => {
	it("shows a local part that needs quotes with its quotes", () => {
		const items = fetchLine(
			`* 2 FETCH (ENVELOPE (NIL "Hi" (("PayPal" NIL "service@paypal.com>" "evil.example")) NIL NIL NIL NIL NIL NIL NIL))`,
		);
		expect(parseEnvelope(items.get("ENVELOPE")).from).toEqual([
			'PayPal <"service@paypal.com>"@evil.example>',
		]);
		const literal = fetchLine(
			`* 2 FETCH (ENVELOPE (NIL "Hi" (("PayPal" NIL "service" "[paypal.com> x]")) NIL NIL NIL NIL NIL NIL NIL))`,
		);
		expect(parseEnvelope(literal.get("ENVELOPE")).from).toEqual([
			'PayPal <service@"[paypal.com> x]">',
		]);
	});

	it("keeps only well-formed message ids, undecoded", () => {
		const items = fetchLine(
			`* 2 FETCH (ENVELOPE (NIL "Hi" NIL NIL NIL NIL NIL NIL "<ok@x>" "=?UTF-8?Q?<a@b>=0DBcc:_x@y?="))`,
		);
		expect(parseEnvelope(items.get("ENVELOPE"))).toMatchObject({
			inReplyTo: "<ok@x>",
			messageId: undefined,
		});
	});

	it("decodes names and subjects, skips group markers, and formats addresses", () => {
		const items = fetchLine(
			`* 2 FETCH (ENVELOPE ("Thu, 22 Oct 2026 16:00:00 +0000" "=?UTF-8?Q?Ren=C3?= =?UTF-8?Q?=A9e?= says hi" (("Doe, Jane" NIL "jane" "example.com")) NIL (("Support" NIL "support" "example.com")) ((NIL NIL "team" NIL)(NIL NIL "a" "x.nl")(NIL NIL NIL NIL)) NIL NIL "<older@x>" "<alt-2@example.com>"))`,
		);
		expect(parseEnvelope(items.get("ENVELOPE"))).toEqual({
			subject: "Renée says hi",
			from: ['"Doe, Jane" <jane@example.com>'],
			replyTo: ["Support <support@example.com>"],
			to: ["a@x.nl"],
			cc: [],
			inReplyTo: "<older@x>",
			messageId: "<alt-2@example.com>",
		});
	});
});
