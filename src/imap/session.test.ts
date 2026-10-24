import { afterEach, describe, expect, it } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { ImapCommandError, ImapConnectionError } from "./connection";
import { ImapSession } from "./session";

type Reply = (socket: Socket, tag: string, literal?: string) => void;

/**
 * A scripted IMAP server over plain TCP. It answers synchronizing literals
 * with `+`, unless `refuseLiteral` says to answer NO instead.
 */
async function fakeImap(
	handle: (command: string) => Reply | undefined,
	refuseLiteral = false,
) {
	const stats = { connections: 0, logins: 0 };
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		stats.connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.write("* OK [CAPABILITY IMAP4rev1 MOVE] ready\r\n");
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
					handle(command)?.(socket, tag, literal);
					continue;
				}
				const lf = buffer.indexOf("\n");
				if (lf === -1) return;
				const line = buffer.subarray(0, lf).toString().replace(/\r$/, "");
				buffer = buffer.subarray(lf + 1);
				const [tag = "", ...rest] = line.split(" ");
				const command = rest.join(" ");
				const literal = /\{(\d+)\}$/.exec(command);
				if (literal) {
					if (refuseLiteral) {
						socket.write(`${tag} NO [OVERQUOTA] too big\r\n`);
						continue;
					}
					pending = { tag, command, size: Number(literal[1]) };
					socket.write("+ go\r\n");
					continue;
				}
				if (command.startsWith("LOGIN")) stats.logins++;
				const reply =
					handle(command) ?? ((s, t) => s.write(`${t} OK done\r\n`));
				reply(socket, tag);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return {
		stats,
		session: (idleMs = 60_000) =>
			new ImapSession(
				{ host: "127.0.0.1", port, user: "me", password: "s3cr3t-pw" },
				() => connect(port, "127.0.0.1"),
				idleMs,
			),
		/** Drops every socket without a word, like a NAT box forgetting the connection. */
		dropAll: () => {
			for (const socket of sockets) socket.destroy();
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ImapSession", () => {
	it("logs in once, reuses the connection, and sends literals after the server's +", async () => {
		let appended = "";
		const server = await fakeImap((command) => {
			if (command.startsWith("APPEND")) {
				return (socket, tag, literal) => {
					appended = literal ?? "";
					socket.write(`${tag} OK [APPENDUID 1 5] saved\r\n`);
				};
			}
			if (command.startsWith("UID SEARCH")) {
				return (socket, tag) =>
					socket.write(`* SEARCH 3 9\r\n${tag} OK done\r\n`);
			}
			return undefined;
		});
		const session = server.session();
		cleanups.push(() => session.close(), server.close);

		const uids = await session.run(async (client) => {
			expect(client.capabilities.has("MOVE")).toBe(true);
			const { data } = await client.exec(["UID SEARCH ALL"]);
			return data[0]?.values;
		});
		expect(uids).toEqual(["3", "9"]);
		const status = await session.run((client) =>
			client.exec([
				"APPEND",
				'"Drafts"',
				{ literal: new TextEncoder().encode("Subject: hi\r\n\r\nbody") },
			]),
		);
		expect(status.status.code).toBe("APPENDUID 1 5");
		expect(appended).toBe("Subject: hi\r\n\r\nbody");
		expect(server.stats).toEqual({ connections: 1, logins: 1 });
	});

	it("keeps the connection usable after the server refuses a literal", async () => {
		const server = await fakeImap(() => undefined, true);
		const session = server.session();
		cleanups.push(() => session.close(), server.close);

		const refused = session.run((client) =>
			client.exec(["APPEND", '"Drafts"', { literal: new Uint8Array(10) }]),
		);
		await expect(refused).rejects.toBeInstanceOf(ImapCommandError);
		const ok = await session.run((client) => client.exec(["NOOP"]));
		expect(ok.status.status).toBe("OK");
		expect(server.stats.connections).toBe(1);
	});

	it("retries a read once on a fresh connection when the reused one is dead", async () => {
		let silent = false;
		const server = await fakeImap((command) =>
			command === "NOOP" && silent ? (socket) => socket.destroy() : undefined,
		);
		const session = server.session();
		cleanups.push(() => session.close(), server.close);

		await session.run((client) => client.exec(["NOOP"]));
		silent = true;
		// The first attempt dies mid-command; the retry runs on a new connection.
		let attempts = 0;
		const result = await session.run((client) => {
			attempts++;
			if (attempts === 2) silent = false;
			return client.exec(["NOOP"]);
		});
		expect(result.status.status).toBe("OK");
		expect(attempts).toBe(2);
		expect(server.stats.logins).toBe(2);

		silent = true;
		const write = session.run((client) => client.exec(["NOOP"]), {
			retry: false,
		});
		await expect(write).rejects.toBeInstanceOf(ImapConnectionError);
	});

	it("reconnects after the server drops an idle connection", async () => {
		const server = await fakeImap(() => undefined);
		const session = server.session();
		cleanups.push(() => session.close(), server.close);

		await session.run((client) => client.exec(["NOOP"]));
		server.dropAll();
		await session.run((client) => client.exec(["NOOP"]));
		expect(server.stats.logins).toBe(2);
	});

	it("explains a rejected login without echoing the password", async () => {
		const server = await fakeImap((command) =>
			command.startsWith("LOGIN")
				? (socket, tag) =>
						socket.write(
							`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`,
						)
				: undefined,
		);
		const session = server.session();
		cleanups.push(() => session.close(), server.close);

		const error = await session.run(async () => {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("app-specific password");
		expect((error as Error).message).not.toContain("s3cr3t-pw");
	});
});
