import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ImapConfig } from "../config";
import {
	type DataResponse,
	ImapCommandError,
	ImapConnection,
	ImapConnectionError,
	type Result,
} from "./connection";
import {
	type CommandPart,
	pairs,
	quoteMailbox,
	str,
	text,
	type Value,
} from "./wire";

/** Opens the transport for a connection; tests swap in a plain socket. */
export type Connect = (
	config: ImapConfig,
) => ConstructorParameters<typeof ImapConnection>[0];

const connectTls: Connect = ({ host, port }) =>
	// SNI takes a hostname; Bun refuses an IP address there.
	tlsConnect({ host, port, servername: isIP(host) ? undefined : host });

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
			let code = greeting.code;
			if (greeting.status !== "PREAUTH") {
				code = (await login(connection, config)).status.code;
			}
			let capabilities = parseCapabilities(code);
			if (capabilities.size === 0) {
				const { data } = await connection.exec(["CAPABILITY"]);
				capabilities = new Set(
					data
						.filter((d) => d.type === "CAPABILITY")
						.flatMap((d) => d.values.map((v) => text(v)?.toUpperCase() ?? "")),
				);
			}
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
			await this.exec([writable ? "SELECT" : "EXAMINE", quoteMailbox(mailbox)]);
		} catch (error) {
			if (!(error instanceof ImapCommandError)) throw error;
			throw new Error(
				`Cannot open mailbox "${mailbox}": ${error.response.text}. mail_list_mailboxes lists the names.`,
				{ cause: error },
			);
		}
		this.selected = { mailbox, writable };
	}

	/** UID SEARCH in the selected mailbox. */
	async uidSearch(criteria: CommandPart[]): Promise<number[]> {
		const { data } = await this.exec(["UID SEARCH", ...criteria]);
		return data
			.filter((d) => d.type === "SEARCH")
			.flatMap((d) => d.values.map((v) => Number(text(v))))
			.filter(Number.isInteger);
	}

	/**
	 * UID FETCH in the selected mailbox, keyed by UID. Unsolicited FETCH
	 * responses without a UID, such as flag updates, are skipped.
	 */
	async uidFetch(
		uids: number[],
		items: string,
	): Promise<Map<number, Map<string, Value>>> {
		const { data } = await this.exec(["UID FETCH", uidSet(uids), `(${items})`]);
		return byUid(data);
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

export function uidSet(uids: number[]): string {
	return [...new Set(uids)].join(",");
}

function byUid(data: DataResponse[]): Map<number, Map<string, Value>> {
	const messages = new Map<number, Map<string, Value>>();
	for (const response of data) {
		if (response.type !== "FETCH") continue;
		const items = pairs(response.values[0]);
		const uid = Number(text(items.get("UID")));
		if (!Number.isInteger(uid)) continue;
		const merged = messages.get(uid) ?? new Map<string, Value>();
		for (const [key, value] of items) merged.set(key, value);
		messages.set(uid, merged);
	}
	return messages;
}

/**
 * Logs in. The rejection text comes from the server, which could echo what it
 * was sent, so the password is cut out of it.
 */
async function login(connection: ImapConnection, config: ImapConfig) {
	try {
		return await connection.exec([
			"LOGIN",
			str(config.user),
			str(config.password),
		]);
	} catch (error) {
		if (!(error instanceof ImapCommandError)) throw error;
		const reason = error.response.text.replaceAll(config.password, "***");
		// No cause: its message is the unredacted server text.
		// oxlint-disable-next-line preserve-caught-error
		throw new Error(
			`The IMAP server rejected the login for ${config.user} (${reason}). ` +
				"For iCloud, ICLOUD_APP_PASSWORD must be an app-specific password from account.apple.com.",
		);
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
	 * Runs `fn` with a logged-in client. When a reused connection turns out
	 * to be dead, `fn` runs again on a fresh one. With `retry: false`, for
	 * work that must not apply twice, a reused connection is checked with
	 * NOOP first and `fn` runs exactly once.
	 */
	run<T>(
		fn: (client: ImapClient) => Promise<T>,
		{ retry = true } = {},
	): Promise<T> {
		return this.enqueue(async () => {
			clearTimeout(this.idleTimer);
			// A connection that failed is closed, so open() replaces it.
			try {
				if (!retry) return await fn(await this.open(true));
				const reused = this.client !== undefined && !this.client.closed;
				try {
					return await fn(await this.open(false));
				} catch (error) {
					if (!(error instanceof ImapConnectionError) || !reused) throw error;
					return await fn(await this.open(false));
				}
			} finally {
				this.scheduleIdleClose();
			}
		});
	}

	/** Logs out once the calls already queued have finished. */
	close(): Promise<void> {
		clearTimeout(this.idleTimer);
		return this.enqueue(async () => {
			const client = this.client;
			this.client = undefined;
			await client?.close();
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		this.tail = result.catch(() => {});
		return result;
	}

	private async open(probe: boolean): Promise<ImapClient> {
		if (this.client && !this.client.closed && probe) {
			await this.client.exec(["NOOP"]).catch((error: unknown) => {
				if (!(error instanceof ImapConnectionError)) throw error;
			});
		}
		if (this.client && !this.client.closed) return this.client;
		this.client = await ImapClient.open(this.config, this.connect);
		return this.client;
	}

	private scheduleIdleClose(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
		this.idleTimer.unref();
	}
}
