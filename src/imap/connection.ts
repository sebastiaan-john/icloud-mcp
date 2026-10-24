import type { Duplex } from "node:stream";
import {
	type CommandPart,
	parseResponse,
	type Response,
	ResponseFramer,
} from "./wire";

export type DataResponse = Extract<Response, { kind: "data" }>;
export type StatusResponse = Extract<Response, { kind: "status" }>;

export interface Result {
	data: DataResponse[];
	status: StatusResponse;
}

/** The server answered NO or BAD; the connection is still usable. */
export class ImapCommandError extends Error {
	constructor(
		command: string,
		readonly response: StatusResponse,
	) {
		const code = response.code ? ` [${response.code}]` : "";
		super(`IMAP ${command} failed: ${response.status}${code} ${response.text}`);
		this.name = "ImapCommandError";
	}
}

/** The connection broke or timed out; open a new one. */
export class ImapConnectionError extends Error {
	constructor(message: string) {
		super(`IMAP connection lost: ${message}`);
		this.name = "ImapConnectionError";
	}
}

interface Pending {
	tags: Set<string>;
	data: DataResponse[];
	statuses: Map<string, StatusResponse>;
	resolve(): void;
	reject(error: Error): void;
	onContinuation?: () => void;
}

/**
 * One IMAP connection over an already connected socket. Commands run one
 * batch at a time; untagged responses that arrive while a batch is in flight
 * belong to that batch.
 */
export class ImapConnection {
	/** The server greeting; rejects on BYE or if the socket closes first. */
	readonly greeting: Promise<StatusResponse>;
	private readonly framer = new ResponseFramer();
	private greetingWaiter?: {
		resolve(response: StatusResponse): void;
		reject(error: Error): void;
	};
	private pending?: Pending;
	private queue: Promise<unknown> = Promise.resolve();
	private nextTag = 1;
	private failure?: Error;
	private byeReceived = false;

	constructor(
		private readonly socket: Duplex & {
			setTimeout(ms: number): unknown;
			destroy(error?: Error): unknown;
		},
		private readonly timeoutMs = 60_000,
	) {
		this.greeting = new Promise((resolve, reject) => {
			this.greetingWaiter = { resolve, reject };
		});
		socket.setTimeout(timeoutMs);
		socket.on("data", (chunk: Uint8Array) => this.onData(chunk));
		socket.on("timeout", () => this.fail("timed out waiting for the server"));
		socket.on("error", (error: Error) => this.fail(error.message));
		// The server hanging up (FIN) ends the session; Bun reports "close" later.
		socket.on("end", () => this.fail("closed by the server"));
		socket.on("close", () => this.fail("closed by the server"));
	}

	get closed(): boolean {
		return this.failure !== undefined;
	}

	/** Runs one command; rejects with ImapCommandError on NO or BAD. */
	async exec(parts: CommandPart[]): Promise<Result> {
		const name = commandName(parts);
		const { data, statuses } = await this.enqueue([parts]);
		const status = statuses[0]!;
		if (status.status !== "OK") throw new ImapCommandError(name, status);
		return { data, status };
	}

	/**
	 * Sends several literal-free commands without waiting between them and
	 * resolves once all are answered, NO and BAD included, in send order.
	 */
	pipeline(commands: string[]) {
		return this.enqueue(commands.map((c) => [c]));
	}

	/** Sends LOGOUT when the connection is idle and closes the socket. */
	async close(): Promise<void> {
		if (this.closed) return;
		await this.exec(["LOGOUT"]).catch(() => {});
		this.fail("logged out");
	}

	private enqueue(commands: CommandPart[][]) {
		const run = () => this.run(commands);
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => {});
		return result;
	}

	private async run(commands: CommandPart[][]) {
		if (this.failure) throw this.failure;
		const tags = commands.map(() => `A${this.nextTag++}`);
		const pending: Pending = {
			tags: new Set(tags),
			data: [],
			statuses: new Map(),
			resolve: () => {},
			reject: () => {},
		};
		const done = new Promise<void>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
		});
		done.catch(() => {});
		this.pending = pending;
		this.socket.setTimeout(this.timeoutMs);
		try {
			for (const [i, parts] of commands.entries()) {
				await this.send(tags[i]!, parts, pending, done);
			}
			await done;
		} finally {
			if (this.pending === pending) this.pending = undefined;
		}
		const statuses = tags.map((tag) => pending.statuses.get(tag)!);
		return { data: pending.data, statuses };
	}

	/** Writes a command, pausing at each literal until the server says `+`. */
	private async send(
		tag: string,
		parts: CommandPart[],
		pending: Pending,
		done: Promise<void>,
	): Promise<void> {
		let line = tag;
		for (const part of parts) {
			if (typeof part === "string") {
				line += ` ${part}`;
				continue;
			}
			const go = new Promise<void>((resolve) => {
				pending.onContinuation = resolve;
			});
			this.socket.write(`${line} {${part.literal.length}}\r\n`);
			// A NO in place of `+` completes the tag; stop sending this command.
			const proceed = await Promise.race([
				go.then(() => true),
				done.then(() => false),
			]);
			if (!proceed) return;
			this.socket.write(part.literal);
			line = "";
		}
		this.socket.write(`${line}\r\n`);
	}

	private onData(chunk: Uint8Array): void {
		let responses: Uint8Array[];
		try {
			responses = this.framer.push(chunk);
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
			return;
		}
		for (const bytes of responses) {
			let response: Response;
			try {
				response = parseResponse(bytes);
			} catch (error) {
				this.fail(
					`unreadable response: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			this.dispatch(response);
		}
	}

	private dispatch(response: Response): void {
		const waiter = this.greetingWaiter;
		if (waiter) {
			if (response.kind !== "status" || response.status === "BYE") {
				this.fail("server refused the connection");
				return;
			}
			this.greetingWaiter = undefined;
			this.socket.setTimeout(0);
			waiter.resolve(response);
			return;
		}
		const pending = this.pending;
		if (response.kind === "continuation") {
			pending?.onContinuation?.();
			return;
		}
		if (response.kind === "data") {
			pending?.data.push(response);
			return;
		}
		if (response.tag === "*") {
			if (response.status === "BYE") this.byeReceived = true;
			return;
		}
		if (!pending?.tags.delete(response.tag)) return;
		pending.statuses.set(response.tag, response);
		if (pending.tags.size === 0) {
			this.socket.setTimeout(0);
			pending.resolve();
		}
	}

	private fail(message: string): void {
		if (this.failure) return;
		this.failure = new ImapConnectionError(
			this.byeReceived ? `server said BYE (${message})` : message,
		);
		this.greetingWaiter?.reject(this.failure);
		this.pending?.reject(this.failure);
		this.socket.destroy();
	}
}

/** The verb for error messages; never includes arguments such as a password. */
function commandName(parts: CommandPart[]): string {
	const first = typeof parts[0] === "string" ? parts[0] : "";
	const words = first.split(" ");
	return words[0] === "UID" ? `UID ${words[1]}` : (words[0] ?? "");
}
