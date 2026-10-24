import { connect, createServer, type Socket } from "node:net";
import { ImapSession } from "./session";

/** What the fake answers: untagged lines plus a status, or a dropped connection. */
export type Answer = { untagged?: string; status?: string } | "drop";

/**
 * A scripted IMAP server on a local socket, for tests. It answers LOGIN,
 * CAPABILITY, and LOGOUT itself, sends `+` for synchronizing literals (or NO
 * with `refuseLiterals`), and records every command after LOGIN.
 */
export async function fakeImap(
	handle: (command: string, literal?: string) => Answer | undefined = () =>
		undefined,
	options: {
		capabilities?: string;
		refuseLiterals?: boolean;
		/** Answers LOGIN with this status instead of OK. */
		loginStatus?: string;
	} = {},
) {
	const capabilities = options.capabilities ?? "IMAP4rev1 MOVE UIDPLUS";
	const stats = { connections: 0, logins: 0, logouts: 0 };
	let logoutWaiters: Array<() => void> = [];
	const commands: string[] = [];
	const literals: string[] = [];
	const sockets = new Set<Socket>();
	const answer = (
		socket: Socket,
		tag: string,
		command: string,
		literal?: string,
	) => {
		if (command.startsWith("LOGIN")) {
			stats.logins++;
			socket.write(`${tag} ${options.loginStatus ?? "OK logged in"}\r\n`);
			return;
		}
		if (command === "CAPABILITY") {
			socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK done\r\n`);
			return;
		}
		if (command === "LOGOUT") {
			stats.logouts++;
			socket.write(`* BYE\r\n${tag} OK\r\n`);
			socket.end();
			for (const resolve of logoutWaiters) resolve();
			logoutWaiters = [];
			return;
		}
		commands.push(command);
		if (literal !== undefined) literals.push(literal);
		const reply = handle(command, literal);
		if (reply === "drop") {
			socket.destroy();
			return;
		}
		socket.write(
			`${reply?.untagged ?? ""}${tag} ${reply?.status ?? "OK done"}\r\n`,
		);
	};
	const server = createServer((socket) => {
		stats.connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.write("* OK ready\r\n");
		let buffer = Buffer.alloc(0);
		let pending: { tag: string; command: string; size: number } | undefined;
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (pending) {
					if (buffer.length < pending.size + 2) return;
					const literal = buffer.subarray(0, pending.size).toString();
					buffer = buffer.subarray(pending.size + 2);
					const { tag, command } = pending;
					pending = undefined;
					answer(socket, tag, command, literal);
					continue;
				}
				const lf = buffer.indexOf("\n");
				if (lf === -1) return;
				const line = buffer.subarray(0, lf).toString().replace(/\r$/, "");
				buffer = buffer.subarray(lf + 1);
				const [tag = "", ...rest] = line.split(" ");
				const command = rest.join(" ");
				const literal = /\{(\d+)\}$/.exec(command);
				if (!literal) {
					answer(socket, tag, command);
				} else if (options.refuseLiterals) {
					socket.write(`${tag} NO [OVERQUOTA] too big\r\n`);
				} else {
					pending = { tag, command, size: Number(literal[1]) };
					socket.write("+ go\r\n");
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		stats,
		commands,
		literals,
		session: (idleMs = 60_000) =>
			new ImapSession(
				{ host: "127.0.0.1", port, user: "me", password: "s3cr3t-pw" },
				() => connect(port, "127.0.0.1"),
				idleMs,
			),
		/** Resolves at the next LOGOUT. */
		nextLogout: () =>
			new Promise<void>((resolve) => logoutWaiters.push(resolve)),
		/** Drops every socket without a word, like a NAT box forgetting the connection. */
		dropAll: () => {
			for (const socket of sockets) socket.destroy();
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
