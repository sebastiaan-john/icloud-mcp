import { afterEach, describe, expect, it } from "bun:test";
import { ImapCommandError, ImapConnectionError } from "./connection";
import { fakeImap } from "./fake-server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(...args: Parameters<typeof fakeImap>) {
	const server = await fakeImap(...args);
	const session = server.session();
	cleanups.push(() => session.close(), server.close);
	return { server, session };
}

describe("ImapSession", () => {
	it("logs in once, reuses the connection, and sends literals after the server's +", async () => {
		const { server, session } = await setup((command) =>
			command.startsWith("UID SEARCH")
				? { untagged: "* SEARCH 3 9\r\n" }
				: command.startsWith("APPEND")
					? { status: "OK [APPENDUID 1 5] saved" }
					: undefined,
		);
		const uids = await session.run(async (client) => {
			expect(client.capabilities.has("MOVE")).toBe(true);
			return client.uidSearch(["ALL"]);
		});
		expect(uids).toEqual([3, 9]);
		const status = await session.run((client) =>
			client.exec([
				"APPEND",
				'"Drafts"',
				{ literal: new TextEncoder().encode("Subject: hi\r\n\r\nbody") },
			]),
		);
		expect(status.status.code).toBe("APPENDUID 1 5");
		expect(server.literals).toEqual(["Subject: hi\r\n\r\nbody"]);
		expect(server.stats).toMatchObject({ connections: 1, logins: 1 });
	});

	it("keeps the connection usable after the server refuses a literal", async () => {
		const { server, session } = await setup(undefined, {
			refuseLiterals: true,
		});
		const refused = session.run((client) =>
			client.exec(["APPEND", '"Drafts"', { literal: new Uint8Array(10) }]),
		);
		await expect(refused).rejects.toBeInstanceOf(ImapCommandError);
		const ok = await session.run((client) => client.exec(["NOOP"]));
		expect(ok.status.status).toBe("OK");
		expect(server.stats.connections).toBe(1);
	});

	it("retries a read once on a fresh connection when the reused one is dead", async () => {
		let drop = false;
		const { server, session } = await setup((command) =>
			command === "NOOP" && drop ? "drop" : undefined,
		);
		await session.run((client) => client.exec(["NOOP"]));
		drop = true;
		let attempts = 0;
		const result = await session.run((client) => {
			attempts++;
			if (attempts === 2) drop = false;
			return client.exec(["NOOP"]);
		});
		expect(result.status.status).toBe("OK");
		expect(attempts).toBe(2);
		expect(server.stats.logins).toBe(2);
	});

	it("runs a write once: a dead reused connection is replaced first, a failure mid-write is not retried", async () => {
		let dropAppend = false;
		const { server, session } = await setup((command) =>
			command.startsWith("APPEND") && dropAppend ? "drop" : undefined,
		);
		await session.run((client) => client.exec(["NOOP"]));
		server.dropAll();
		let attempts = 0;
		const append = (
			client: Parameters<Parameters<typeof session.run>[0]>[0],
		) => {
			attempts++;
			return client.exec([
				"APPEND",
				'"Drafts"',
				{ literal: new Uint8Array(3) },
			]);
		};
		await session.run(append, { retry: false });
		expect(attempts).toBe(1);
		expect(server.stats.logins).toBe(2);

		dropAppend = true;
		await expect(session.run(append, { retry: false })).rejects.toBeInstanceOf(
			ImapConnectionError,
		);
		expect(attempts).toBe(2);
		expect(server.literals).toHaveLength(2);
	});

	it("runs calls one at a time on one connection", async () => {
		const { server, session } = await setup();
		const order: string[] = [];
		const call = (name: string) =>
			session.run(async (client) => {
				order.push(`${name}1`);
				await client.exec(["NOOP"]);
				order.push(`${name}2`);
			});
		await Promise.all([call("a"), call("b")]);
		expect(order).toEqual(["a1", "a2", "b1", "b2"]);
		expect(server.stats.connections).toBe(1);
	});

	it("logs out after the idle time and reconnects on the next call", async () => {
		const server = await fakeImap();
		const session = server.session(1);
		cleanups.push(() => session.close(), server.close);
		const loggedOut = server.nextLogout();
		await session.run((client) => client.exec(["NOOP"]));
		await loggedOut;
		await session.run((client) => client.exec(["NOOP"]));
		expect(server.stats).toMatchObject({ connections: 2, logouts: 1 });
	});

	it("explains a rejected login without echoing the password", async () => {
		const { session } = await setup(undefined, {
			loginStatus: "NO [AUTHENTICATIONFAILED] bad password s3cr3t-pw",
		});
		const error = await session.run(async () => {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("app-specific password");
		expect(message).not.toContain("s3cr3t-pw");
	});
});
