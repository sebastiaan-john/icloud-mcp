import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Config } from "./config";
import { errorMessage } from "./errors";

export type SmtpConfig = Config["smtp"];

const TIMEOUT_MS = 60_000;

/** The server refused the message or the connection failed before the body was sent. */
export class SmtpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SmtpError";
	}
}

/** The body was handed over but no answer came back, so it may have been delivered. */
export class MaybeSentError extends Error {
	constructor(cause: unknown) {
		super(
			`${errorMessage(cause)}. The message may have been sent anyway; check the Sent mailbox before sending it again.`,
			{ cause },
		);
		this.name = "MaybeSentError";
	}
}

interface Reply {
	code: number;
	text: string;
}

/** Collects SMTP reply lines (`250-...` continued, `250 ...` final) from one socket. */
class ReplyReader {
	private buffer = "";
	private replies: Reply[] = [];
	private lines: string[] = [];
	private waiter?: { resolve(reply: Reply): void; reject(error: Error): void };
	private failure?: Error;
	private readonly onChunk = (chunk: Buffer) =>
		this.onData(chunk.toString("utf8"));
	private readonly onError = (error: Error) => this.fail(error);
	private readonly onClose = () =>
		this.fail(new SmtpError("SMTP connection closed"));
	private readonly onTimeout = () => {
		this.fail(new SmtpError("SMTP server timed out"));
		this.socket.destroy();
	};

	constructor(private readonly socket: Socket) {
		socket.on("data", this.onChunk);
		socket.on("error", this.onError);
		socket.on("close", this.onClose);
		socket.on("timeout", this.onTimeout);
	}

	/** True when the server sent bytes nobody has read yet. */
	get unread(): boolean {
		return (
			this.buffer !== "" || this.lines.length > 0 || this.replies.length > 0
		);
	}

	detach(): void {
		this.socket.off("data", this.onChunk);
		this.socket.off("error", this.onError);
		this.socket.off("close", this.onClose);
		this.socket.off("timeout", this.onTimeout);
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

/** Waits for a connect event; a close or timeout first is a failure, not a hang. */
function connected(
	socket: Socket,
	event: "connect" | "secureConnect",
): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once(event, () => resolve());
		socket.once("error", reject);
		socket.once("close", () => reject(new SmtpError("SMTP connection closed")));
		socket.once("timeout", () => {
			reject(new SmtpError("SMTP server timed out"));
			socket.destroy();
		});
	});
}

function servername(host: string): string | undefined {
	// SNI takes a hostname; Bun refuses an IP address there.
	return isIP(host) ? undefined : host;
}

/** Escapes lines that start with a dot and ends the body with CRLF.CRLF. */
export function dotStuff(raw: Uint8Array): Uint8Array {
	const text = Buffer.from(raw).toString("latin1").replace(/\r?\n/g, "\r\n");
	const body = text.replace(/^\./gm, "..");
	const ending = body.endsWith("\r\n") ? "" : "\r\n";
	return Buffer.from(`${body}${ending}.\r\n`, "latin1");
}

/**
 * Sends one message with AUTH PLAIN over TLS and closes the connection.
 * Throws MaybeSentError when the reply to the body never arrived; any other
 * failure (a refusal, a closed or timed-out connection, a socket error) means
 * nothing was sent.
 */
export async function sendMail(
	config: SmtpConfig,
	from: string,
	recipients: string[],
	raw: Uint8Array,
): Promise<void> {
	const { host, port } = config;
	const implicitTls = port === 465;
	let socket: Socket = implicitTls
		? tlsConnect({ host, port, servername: servername(host) })
		: netConnect({ host, port });
	socket.setTimeout(TIMEOUT_MS);
	let reader = new ReplyReader(socket);

	const expectReply = async (stage: string, codes: number[]) => {
		const reply = await reader.next();
		if (!codes.includes(reply.code)) {
			throw new SmtpError(
				`SMTP ${stage} rejected: ${reply.code} ${reply.text.replace(/\n/g, " ")}`,
			);
		}
		return reply;
	};
	/** `stage` names the step in errors, so the AUTH line never appears in one. */
	const command = (stage: string, line: string, codes: number[]) => {
		socket.write(`${line}\r\n`);
		return expectReply(stage, codes);
	};

	try {
		await connected(socket, implicitTls ? "secureConnect" : "connect");
		await expectReply("greeting", [220]);
		const ehlo = await command("EHLO", "EHLO [127.0.0.1]", [250]);
		if (!implicitTls) {
			if (!/^STARTTLS\b/im.test(ehlo.text)) {
				throw new SmtpError(
					"SMTP server does not offer STARTTLS; refusing to send in clear text",
				);
			}
			await command("STARTTLS", "STARTTLS", [220]);
			// Anything already buffered arrived unencrypted and could be forged
			// replies for the commands sent over TLS (RFC 3207 section 4.2).
			if (reader.unread) {
				throw new SmtpError("SMTP server sent data before the TLS handshake");
			}
			reader.detach();
			const secure = tlsConnect({ socket, servername: servername(host) });
			secure.setTimeout(TIMEOUT_MS);
			reader = new ReplyReader(secure);
			await connected(secure, "secureConnect");
			socket = secure;
			await command("EHLO", "EHLO [127.0.0.1]", [250]);
		}
		const credentials = Buffer.from(
			`\0${config.user}\0${config.password}`,
		).toString("base64");
		await command("AUTH", `AUTH PLAIN ${credentials}`, [235]);
		await command("MAIL FROM", `MAIL FROM:<${from}>`, [250]);
		for (const recipient of recipients) {
			await command(
				`RCPT TO ${recipient}`,
				`RCPT TO:<${recipient}>`,
				[250, 251],
			);
		}
		await command("DATA", "DATA", [354]);
		socket.write(dotStuff(raw));
		const reply = await reader.next().catch((error: unknown) => {
			throw new MaybeSentError(error);
		});
		if (reply.code !== 250) {
			throw new SmtpError(
				`SMTP message rejected: ${reply.code} ${reply.text.replace(/\n/g, " ")}`,
			);
		}
		socket.write("QUIT\r\n");
		socket.end();
	} catch (error) {
		socket.destroy();
		throw error;
	}
}
