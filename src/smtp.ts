import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface SmtpConfig {
	host: string;
	/** 465 means TLS from the first byte; any other port upgrades with STARTTLS. */
	port: number;
	user: string;
	password: string;
}

export class SmtpError extends Error {
	constructor(
		message: string,
		/** The server's reply code when it rejected a command; absent when the connection failed. */
		readonly code?: number,
		/** True when the body was handed over but no answer came back, so it may have been sent. */
		readonly maybeSent = false,
	) {
		super(message);
		this.name = "SmtpError";
	}
}

interface Reply {
	code: number;
	text: string;
}

/** Collects SMTP reply lines (`250-...` continued, `250 ...` final) from a socket. */
class ReplyReader {
	private buffer = "";
	private replies: Reply[] = [];
	private lines: string[] = [];
	private waiter?: { resolve(reply: Reply): void; reject(error: Error): void };
	private failure?: Error;

	attach(socket: Socket | TLSSocket): void {
		socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () =>
			this.fail(new SmtpError("SMTP connection closed")),
		);
		socket.on("timeout", () => {
			this.fail(new SmtpError("SMTP server timed out"));
			socket.destroy();
		});
	}

	detach(socket: Socket): void {
		socket.removeAllListeners("data");
		socket.removeAllListeners("close");
		socket.removeAllListeners("timeout");
	}

	next(): Promise<Reply> {
		const reply = this.replies.shift();
		if (reply) return Promise.resolve(reply);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiter = { resolve, reject };
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let lf: number;
		while ((lf = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, lf).replace(/\r$/, "");
			this.buffer = this.buffer.slice(lf + 1);
			this.lines.push(line.slice(4));
			if (line[3] === "-") continue;
			const reply = {
				code: Number(line.slice(0, 3)),
				text: this.lines.join("\n"),
			};
			this.lines = [];
			const waiter = this.waiter;
			this.waiter = undefined;
			if (waiter) waiter.resolve(reply);
			else this.replies.push(reply);
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		this.waiter?.reject(this.failure);
		this.waiter = undefined;
	}
}

function once(
	socket: Socket,
	event: "connect" | "secureConnect",
): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once(event, () => resolve());
		socket.once("error", reject);
	});
}

/** Escapes lines that start with a dot and ends the body with CRLF.CRLF. */
function dotStuff(raw: Uint8Array): Uint8Array {
	const text = Buffer.from(raw).toString("latin1").replace(/\r?\n/g, "\r\n");
	const body = text.replace(/^\./gm, "..");
	const ending = body.endsWith("\r\n") ? "" : "\r\n";
	return Buffer.from(`${body}${ending}.\r\n`, "latin1");
}

/**
 * Sends one message with AUTH PLAIN over TLS and closes the connection. A
 * failure before DATA means nothing was sent; one after it sets `maybeSent`.
 */
export async function sendMail(
	config: SmtpConfig,
	from: string,
	recipients: string[],
	raw: Uint8Array,
	timeoutMs = 60_000,
): Promise<void> {
	const reader = new ReplyReader();
	const implicitTls = config.port === 465;
	let socket: Socket = implicitTls
		? tlsConnect({
				host: config.host,
				port: config.port,
				servername: config.host,
			})
		: netConnect({ host: config.host, port: config.port });
	socket.setTimeout(timeoutMs);
	reader.attach(socket);
	await once(socket, implicitTls ? "secureConnect" : "connect");

	let stage = "greeting";
	const expect = async (codes: number[]) => {
		const reply = await reader.next();
		if (!codes.includes(reply.code)) {
			throw new SmtpError(
				`SMTP ${stage} rejected: ${reply.code} ${reply.text.replace(/\n/g, " ")}`,
				reply.code,
			);
		}
		return reply;
	};
	const command = async (line: string, codes: number[], name = line) => {
		stage = name;
		socket.write(`${line}\r\n`);
		return expect(codes);
	};

	try {
		await expect([220]);
		const ehlo = await command("EHLO [127.0.0.1]", [250], "EHLO");
		if (!implicitTls) {
			if (!/^STARTTLS\b/im.test(ehlo.text)) {
				throw new SmtpError(
					"SMTP server does not offer STARTTLS; refusing to send in clear text",
				);
			}
			await command("STARTTLS", [220]);
			reader.detach(socket);
			const secure = tlsConnect({ socket, servername: config.host });
			secure.setTimeout(timeoutMs);
			reader.attach(secure);
			await once(secure, "secureConnect");
			socket = secure;
			await command("EHLO [127.0.0.1]", [250], "EHLO");
		}
		const credentials = Buffer.from(
			`\0${config.user}\0${config.password}`,
		).toString("base64");
		await command(`AUTH PLAIN ${credentials}`, [235], "AUTH");
		await command(`MAIL FROM:<${from}>`, [250], "MAIL FROM");
		for (const recipient of recipients) {
			await command(
				`RCPT TO:<${recipient}>`,
				[250, 251],
				`RCPT TO ${recipient}`,
			);
		}
		await command("DATA", [354]);
		stage = "message";
		socket.write(dotStuff(raw));
		await expect([250]).catch((error: unknown) => {
			// A rejection after the body is a clear no; a lost reply is not.
			if (error instanceof SmtpError && error.code !== undefined) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new SmtpError(message, undefined, true);
		});
		socket.write("QUIT\r\n");
		socket.end();
	} catch (error) {
		socket.destroy();
		throw error;
	}
}
