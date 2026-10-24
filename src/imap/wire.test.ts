import { describe, expect, it } from "bun:test";
import {
	decodeMailbox,
	encodeMailbox,
	internalDate,
	pairs,
	parseResponse,
	quoteMailbox,
	ResponseFramer,
	str,
} from "./wire";

const bytes = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("ResponseFramer", () => {
	it("frames responses across chunk boundaries, including literals that contain CRLF", () => {
		const stream =
			"* 1 FETCH (UID 7 BODY[] {12}\r\nline1\r\nline2 FLAGS ())\r\nA1 OK done\r\n";
		const framer = new ResponseFramer();
		const out: string[] = [];
		for (const char of stream)
			out.push(...framer.push(bytes(char)).map(decode));
		expect(out).toEqual([
			"* 1 FETCH (UID 7 BODY[] {12}\r\nline1\r\nline2 FLAGS ())\r\n",
			"A1 OK done\r\n",
		]);
	});

	it("never reads a literal into status text that ends in {n}", () => {
		const framer = new ResponseFramer();
		const frames = framer.push(
			bytes("A1 NO quota exceeded {3}\r\nA2 OK fine\r\n+ send {5}\r\n"),
		);
		expect(frames.map(decode)).toEqual([
			"A1 NO quota exceeded {3}\r\n",
			"A2 OK fine\r\n",
			"+ send {5}\r\n",
		]);
	});

	it("handles a literal far larger than its buffer", () => {
		const big = "x".repeat(300_000);
		const framer = new ResponseFramer();
		const frames = [
			...framer.push(bytes(`* 1 FETCH (BODY[1] {${big.length}}\r\n`)),
			...framer.push(bytes(big.slice(0, 150_000))),
			...framer.push(bytes(`${big.slice(150_000)})\r\n`)),
		];
		expect(frames).toHaveLength(1);
		const response = parseResponse(frames[0]!);
		expect(response.kind).toBe("data");
		if (response.kind !== "data") return;
		const body = pairs(response.values[0]).get("BODY[1]");
		expect(body).toBeInstanceOf(Uint8Array);
		expect((body as Uint8Array).length).toBe(big.length);
	});
});

describe("parseResponse", () => {
	it("parses status responses with a code", () => {
		expect(
			parseResponse(bytes("A4 OK [APPENDUID 3 9] Append completed\r\n")),
		).toEqual({
			kind: "status",
			tag: "A4",
			status: "OK",
			code: "APPENDUID 3 9",
			text: "Append completed",
		});
	});

	it("keeps bracketed section names as one atom and reads NIL, quoted strings, and lists", () => {
		const response = parseResponse(
			bytes(
				'* 3 FETCH (UID 12 FLAGS (\\Seen $Junk) BODY[HEADER.FIELDS (REFERENCES)] {10}\r\nRef: <a>\r\n ENVELOPE (NIL "Hi \\"you\\""))\r\n',
			),
		);
		if (response.kind !== "data") throw new Error("expected data");
		expect(response.type).toBe("FETCH");
		const items = pairs(response.values[0]);
		expect(items.get("UID")).toBe("12");
		expect(items.get("FLAGS")).toEqual(["\\Seen", "$Junk"]);
		expect(
			decode(items.get("BODY[HEADER.FIELDS (REFERENCES)]") as Uint8Array),
		).toBe("Ref: <a>\r\n");
		expect(items.get("ENVELOPE")).toEqual([null, 'Hi "you"']);
	});

	it("treats a bracket in a keyword as text", () => {
		const response = parseResponse(
			bytes("* 1 FETCH (UID 1 FLAGS ([project] a[b \\Seen))\r\n"),
		);
		if (response.kind !== "data") throw new Error("expected data");
		expect(pairs(response.values[0]).get("FLAGS")).toEqual([
			"[project]",
			"a[b",
			"\\Seen",
		]);
	});

	it("parses continuation requests", () => {
		expect(parseResponse(bytes("+ Ready for literal data\r\n"))).toEqual({
			kind: "continuation",
			text: "Ready for literal data",
		});
	});
});

describe("internalDate", () => {
	it("keeps the offset and pads a one-digit day", () => {
		expect(internalDate(" 4-Oct-2026 09:15:00 +0200")).toBe(
			"2026-10-04T09:15:00+02:00",
		);
		expect(internalDate("4-Foo-2026 09:15:00 +0200")).toBeUndefined();
	});
});

describe("arguments", () => {
	it("quotes ASCII and sends anything else as a literal", () => {
		expect(str('say "hi" \\o/')).toBe('"say \\"hi\\" \\\\o/"');
		expect(str("café")).toEqual({ literal: bytes("café") });
	});

	it("round-trips mailbox names through modified UTF-7", () => {
		expect(encodeMailbox("Projecten/Café")).toBe("Projecten/Caf&AOk-");
		expect(encodeMailbox("R&D")).toBe("R&-D");
		for (const name of ["Projecten/Café", "R&D", "日本語", "Ünï & 😀"]) {
			expect(decodeMailbox(encodeMailbox(name))).toBe(name);
		}
		expect(quoteMailbox("Sent Messages")).toBe('"Sent Messages"');
	});
});
