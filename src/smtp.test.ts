import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { dotStuff, SmtpError, sendMail } from "./smtp";

/** A plain-TCP SMTP server that answers each command line from a script. */
async function fakeSmtp(reply: (line: string) => string) {
	const lines: string[] = [];
	const server: Server = createServer((socket) => {
		socket.write("220 fake ESMTP\r\n");
		socket.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
				lines.push(line);
				socket.write(reply(line));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	cleanups.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const send = () =>
		sendMail(
			{ host: "127.0.0.1", port, user: "me@icloud.com", password: "secret" },
			"me@icloud.com",
			["jan@example.nl"],
			new Uint8Array(),
		).catch((error: unknown) => error);
	return { lines, send };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("sendMail", () => {
	it("refuses to authenticate without STARTTLS", async () => {
		const smtp = await fakeSmtp((line) =>
			line.startsWith("EHLO") ? "250-fake\r\n250 AUTH PLAIN\r\n" : "500 no\r\n",
		);
		const error = await smtp.send();
		expect(error).toBeInstanceOf(SmtpError);
		expect(String(error)).toContain("STARTTLS");
		expect(smtp.lines.some((line) => line.startsWith("AUTH"))).toBe(false);
	});

	it("stops when the server sends replies ahead of the TLS handshake", async () => {
		const smtp = await fakeSmtp((line) => {
			if (line.startsWith("EHLO")) return "250-fake\r\n250 STARTTLS\r\n";
			// A man in the middle queues answers for the commands sent over TLS.
			if (line === "STARTTLS") return "220 go ahead\r\n250 fake\r\n235 ok\r\n";
			return "500 no\r\n";
		});
		const error = await smtp.send();
		expect(error).toBeInstanceOf(SmtpError);
		expect(String(error)).toContain("before the TLS handshake");
	});
});

describe("dotStuff", () => {
	it("escapes leading dots and terminates the body", () => {
		const raw = new TextEncoder().encode(".one\n..two\n.\nend");
		expect(new TextDecoder().decode(dotStuff(raw))).toBe(
			"..one\r\n...two\r\n..\r\nend\r\n.\r\n",
		);
	});
});
