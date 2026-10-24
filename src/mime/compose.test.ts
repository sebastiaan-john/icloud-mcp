import { describe, expect, it } from "bun:test";
import { compose, encodeQuotedPrintable, parseAddress } from "./compose";
import { decodeCharset, decodeHeader, decodeTransfer } from "./decode";

const message = {
	from: "Sebastiaan Dijkstra <sebastiaan@icloud.com>",
	to: ["Jöhn Smith <john@example.com>", "jan@example.nl"],
	cc: ['"Doe, Jane" <jane@example.com>'],
	bcc: ["secret@example.com", "JAN@example.nl"],
	subject:
		"Offerte – €500 voor het project dat we vorige week bespraken, met details",
	body: "Hoi,\n\n.leading dot\nÉén café",
	inReplyTo: "<orig@example.com>",
	references: ["<root@example.com>", "<orig@example.com>"],
};

function headersOf(raw: Uint8Array) {
	const text = new TextDecoder().decode(raw);
	const split = text.indexOf("\r\n\r\n");
	const head = text.slice(0, split);
	const body = text.slice(split + 4);
	const unfolded = head.replace(/\r\n[ \t]/g, " ");
	const headers = new Map(
		unfolded.split("\r\n").map((line) => {
			const i = line.indexOf(":");
			return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
		}),
	);
	return { text, headers, body };
}

describe("compose", () => {
	it("writes encoded headers, threading, and a quoted-printable body that decodes back", () => {
		const date = new Date("2026-10-24T21:05:09+02:00");
		const { raw, messageId, recipients } = compose(message, { date });
		const { text, headers, body } = headersOf(raw);
		expect(text.split("\r\n").every((line) => line.length <= 78)).toBe(true);
		expect(decodeHeader(headers.get("subject")!)).toBe(message.subject);
		expect(decodeHeader(headers.get("to")!)).toBe(
			"Jöhn Smith <john@example.com>, jan@example.nl",
		);
		expect(headers.get("cc")).toBe('"Doe, Jane" <jane@example.com>');
		expect(headers.has("bcc")).toBe(false);
		expect(headers.get("message-id")).toBe(messageId);
		expect(messageId).toMatch(/^<[0-9a-f]{32}@icloud\.com>$/);
		expect(headers.get("in-reply-to")).toBe("<orig@example.com>");
		expect(headers.get("references")).toBe(
			"<root@example.com> <orig@example.com>",
		);
		expect(new Date(headers.get("date") ?? "").getTime()).toBe(date.getTime());
		const decoded = decodeCharset(
			decodeTransfer(Buffer.from(body, "latin1"), "quoted-printable"),
		);
		expect(decoded.replace(/\r\n/g, "\n")).toBe(`${message.body}\n`);
		expect(recipients).toEqual([
			"john@example.com",
			"jan@example.nl",
			"jane@example.com",
			"secret@example.com",
		]);
	});

	it("keeps Bcc as a header for drafts", () => {
		const { headers } = headersOf(compose(message, { includeBcc: true }).raw);
		expect(headers.get("bcc")).toBe("secret@example.com, JAN@example.nl");
	});

	it("sends to addresses as written and refuses a header value with a line break", () => {
		const { recipients } = compose({
			...message,
			to: ["Jan.Smit@Example.nl"],
			cc: [],
			bcc: [],
		});
		expect(recipients).toEqual(["Jan.Smit@Example.nl"]);
		expect(() => compose({ ...message, inReplyTo: "<a@b>\rBcc: x@y" })).toThrow(
			"line break",
		);
	});

	it("encodes a long unbroken subject so no line passes 998 characters", () => {
		const { raw } = compose({ ...message, subject: "x".repeat(1200) });
		const text = new TextDecoder().decode(raw);
		expect(text.split("\r\n").every((line) => line.length <= 78)).toBe(true);
		expect(decodeHeader(headersOf(raw).headers.get("subject") ?? "")).toBe(
			"x".repeat(1200),
		);
	});

	it("rejects something that is not an address", () => {
		expect(() => compose({ ...message, cc: ["nobody"] })).toThrow(
			"Not an email address",
		);
	});
});

describe("encodeQuotedPrintable", () => {
	it("soft-breaks long lines and protects trailing spaces", () => {
		const encoded = encodeQuotedPrintable(`${"a".repeat(100)}\ntrailing `);
		const lines = encoded.split("\r\n");
		expect(lines.every((l) => l.length <= 76)).toBe(true);
		expect(lines.at(-1)).toBe("trailing=20");
		expect(lines[0]!.endsWith("=")).toBe(true);
	});
});

describe("parseAddress", () => {
	it("splits names from addresses and rejects header injection", () => {
		expect(parseAddress('"Doe, Jane" <jane@example.com>')).toEqual({
			name: "Doe, Jane",
			address: "jane@example.com",
		});
		expect(parseAddress("jan@example.nl")).toEqual({
			address: "jan@example.nl",
		});
		expect(parseAddress("Eve <eve@x.com>\r\nBcc: all@x.com")).toBeUndefined();
		expect(parseAddress("no-at-sign")).toBeUndefined();
		expect(parseAddress("Eve\r <eve@x.com>")).toBeUndefined();
		// Non-ASCII addresses would need SMTPUTF8, which the sender does not use.
		expect(parseAddress("jöhn@example.com")).toBeUndefined();
		expect(parseAddress(`x${" ".repeat(50_000)}y`)).toBeUndefined();
	});
});
