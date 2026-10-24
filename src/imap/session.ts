import { connect as tlsConnect } from "node:tls";
import type { ImapConfig } from "../config";
import {
	ImapCommandError,
	ImapConnection,
	ImapConnectionError,
	type Result,
} from "./connection";
import { type CommandPart, mailboxArg, str } from "./wire";

/** Opens the transport for a connection; tests swap in a plain socket. */
export type Connect = (
	config: ImapConfig,
) => ConstructorParameters<typeof ImapConnection>[0];

const connectTls: Connect = (config) =>
	tlsConnect({ host: config.host, port: config.port, servername: config.host });

/** A logged-in connection that remembers its selected mailbox. */
export class ImapClient {
	private selected?: { mailbox: string; writable: boolean };

	private constructor(
		private readonly connection: ImapConnection,
		readonly capabilities: Set<string>,
	) {}

	static async open(config: ImapConfig, connect: Connect): Promise<ImapClient> {
		const connection = new ImapConnection(connect(config));
		try {
			const greeting = await connection.greeting;
			let login: Result;
			try {
				login = await connection.exec([
					"LOGIN",
					str(config.user),
					str(config.password),
				]);
			} catch (error) {
				if (error instanceof ImapCommandError) {
					throw new Error(
						`The IMAP server rejected the login for ${config.user} (${error.response.text}). ` +
							"For iCloud, ICLOUD_EMAIL must be your @icloud.com address and ICLOUD_APP_PASSWORD an app-specific password from account.apple.com.",
						{ cause: error },
					);
				}
				throw error;
			}
			let capabilities = parseCapabilities(login.status.code);
			if (capabilities.size === 0) {
				const { data } = await connection.exec(["CAPABILITY"]);
				capabilities = new Set(
					data
						.filter((d) => d.type === "CAPABILITY")
						.flatMap((d) => d.values.map((v) => String(v).toUpperCase())),
				);
			}
			if (capabilities.size === 0)
				capabilities = parseCapabilities(greeting.code);
			return new ImapClient(connection, capabilities);
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	get closed(): boolean {
		return this.connection.closed;
	}

	/**
	 * Opens a mailbox with EXAMINE for reads or SELECT for writes, skipping
	 * the round trip when it is already open in a sufficient mode.
	 */
	async select(mailbox: string, writable = false): Promise<void> {
		const current = this.selected;
		if (current?.mailbox === mailbox && (current.writable || !writable)) return;
		// A failed SELECT leaves no mailbox open.
		this.selected = undefined;
		try {
			await this.exec([writable ? "SELECT" : "EXAMINE", mailboxArg(mailbox)]);
		} catch (error) {
			if (!(error instanceof ImapCommandError)) throw error;
			throw new Error(
				`Cannot open mailbox "${mailbox}": ${error.response.text}. mail_list_mailboxes lists the names.`,
				{ cause: error },
			);
		}
		this.selected = { mailbox, writable };
	}

	exec(parts: CommandPart[]): Promise<Result> {
		return this.connection.exec(parts);
	}

	pipeline(commands: string[]) {
		return this.connection.pipeline(commands);
	}

	close(): Promise<void> {
		return this.connection.close();
	}
}

function parseCapabilities(code: string): Set<string> {
	const [name, ...rest] = code.split(" ");
	if (name?.toUpperCase() !== "CAPABILITY") return new Set();
	return new Set(rest.map((c) => c.toUpperCase()));
}

/**
 * Owns the one IMAP connection for this process. Work runs one call at a
 * time; the connection opens on first use, is reused while calls keep
 * coming, and closes after `idleMs` without one.
 */
export class ImapSession {
	private client?: ImapClient;
	private tail: Promise<unknown> = Promise.resolve();
	private idleTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly config: ImapConfig,
		private readonly connect: Connect = connectTls,
		private readonly idleMs = 5 * 60_000,
	) {}

	/**
	 * Runs `fn` with a logged-in client. When a reused connection turns out to
	 * be dead, `fn` runs once more on a fresh one, unless `retry` is false
	 * because repeating it could apply a write twice.
	 */
	run<T>(
		fn: (client: ImapClient) => Promise<T>,
		{ retry = true } = {},
	): Promise<T> {
		const task = async () => {
			clearTimeout(this.idleTimer);
			try {
				const reused = this.client !== undefined && !this.client.closed;
				try {
					return await fn(await this.open());
				} catch (error) {
					if (!(error instanceof ImapConnectionError)) throw error;
					this.client = undefined;
					if (!reused || !retry) throw error;
					return await fn(await this.open());
				}
			} finally {
				this.scheduleIdleClose();
			}
		};
		const result = this.tail.then(task, task);
		this.tail = result.catch(() => {});
		return result;
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}

	private async open(): Promise<ImapClient> {
		if (this.client && !this.client.closed) return this.client;
		this.client = await ImapClient.open(this.config, this.connect);
		return this.client;
	}

	private scheduleIdleClose(): void {
		clearTimeout(this.idleTimer);
		// Queued like any call, so it cannot close a connection that is in use.
		this.idleTimer = setTimeout(() => {
			this.tail = this.tail.then(() => this.close()).catch(() => {});
		}, this.idleMs);
		this.idleTimer.unref?.();
	}
}
