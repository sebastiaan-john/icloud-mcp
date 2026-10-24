import { afterEach, describe, expect, it } from "bun:test";
import { type Answer, fakeImap } from "./imap/fake-server";
import { ImapMail } from "./mail";
import { MaybeSentError } from "./smtp";

const config = {
	from: "Me <me@icloud.com>",
	smtp: { host: "h", port: 587, user: "me@icloud.com", password: "p" },
};
const LIST = [
	'* LIST (\\HasNoChildren) "/" "INBOX"\r\n',
	'* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n',
	'* LIST (\\HasNoChildren) "/" "Drafts"\r\n',
].join("");
const PLAIN =
	'("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 5 1 NIL NIL NIL NIL)';
/** An ENVELOPE from Jan with the given To and optional Reply-To and Cc lists. */
const envelope = (to: string, { replyTo = "NIL", cc = "NIL" } = {}) =>
	`("d" "Koffie?" (("Jan" NIL "jan" "example.nl")) NIL ${replyTo} ${to} ${cc} NIL NIL "<o@x>")`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
	handle: (command: string) => Answer | undefined,
	capabilities?: string,
) {
	const server = await fakeImap(handle, { capabilities });
	const session = server.session();
	cleanups.push(() => session.close(), server.close);
	const delivered: Array<{ rcpt: string[]; raw: string }> = [];
	const mail = new ImapMail(
		session,
		config,
		async (_smtp, _from, rcpt, raw) => {
			delivered.push({ rcpt, raw: new TextDecoder().decode(raw) });
		},
	);
	return { server, mail, delivered };
}

/** Answers LIST, the Sent search, and a FETCH of message 7 with this envelope and References. */
function mailbox(original: string, references = "<a@x> <b@x>", filed = false) {
	const header = `References: ${references}\r\n\r\n`;
	return (command: string): Answer | undefined => {
		if (command.startsWith("LIST")) return { untagged: LIST };
		if (command.startsWith("UID SEARCH HEADER")) {
			return { untagged: filed ? "* SEARCH 4\r\n" : "* SEARCH\r\n" };
		}
		if (command.startsWith("UID FETCH 7")) {
			return {
				untagged: `* 1 FETCH (UID 7 ENVELOPE ${original} BODY[HEADER.FIELDS (REFERENCES)] {${header.length}}\r\n${header})\r\n`,
			};
		}
		return undefined;
	};
}

const reply = (all: boolean) => ({
	to: [],
	cc: [],
	bcc: [],
	body: "ok",
	reply: { mailbox: "INBOX", uid: 7, all },
});

describe("ImapMail replies", () => {
	it("answers the sender, threads, and marks the original answered", async () => {
		const { server, mail, delivered } = await setup(
			mailbox(envelope('(("Me" NIL "me" "icloud.com"))')),
		);
		await mail.send(reply(false));
		expect(delivered[0]?.rcpt).toEqual(["jan@example.nl"]);
		expect(delivered[0]?.raw).toContain("Subject: Re: Koffie?");
		expect(delivered[0]?.raw).toContain("In-Reply-To: <o@x>");
		expect(delivered[0]?.raw).toContain("References: <a@x> <b@x> <o@x>");
		expect(server.commands).toContain("UID STORE 7 +FLAGS.SILENT (\\Answered)");
	});

	it("copies everyone else on reply-all, without yourself or duplicates", async () => {
		const { mail, delivered } = await setup(
			mailbox(
				envelope('(("Me" NIL "ME" "icloud.com")(NIL NIL "piet" "x.nl"))', {
					cc: '((NIL NIL "jan" "example.nl")(NIL NIL "team" "x.nl"))',
				}),
			),
		);
		await mail.send({ ...reply(true), cc: ["Team <team@x.nl>"] });
		expect(delivered[0]?.rcpt).toEqual([
			"jan@example.nl",
			"team@x.nl",
			"piet@x.nl",
		]);
	});

	it("prefers Reply-To and answers your own message to its recipients", async () => {
		const replyTo = await setup(
			mailbox(envelope("NIL", { replyTo: '(("List" NIL "list" "x.nl"))' })),
		);
		await replyTo.mail.send(reply(false));
		expect(replyTo.delivered[0]?.rcpt).toEqual(["list@x.nl"]);

		const own = await setup(
			mailbox(
				'("d" "Plan" (("Me" NIL "me" "icloud.com")) NIL NIL (("Jan" NIL "jan" "example.nl")) NIL NIL NIL "<o@x>")',
			),
		);
		await own.mail.send(reply(false));
		expect(own.delivered[0]?.rcpt).toEqual(["jan@example.nl"]);
	});

	it("keeps the thread root from glued or commented References", async () => {
		const { mail, delivered } = await setup(
			mailbox(
				envelope('(("Me" NIL "me" "icloud.com"))'),
				"<root@x>(first)<mid@x>",
			),
		);
		await mail.send(reply(false));
		expect(delivered[0]?.raw).toContain("References: <root@x> <mid@x> <o@x>");
	});

	it("ignores ids inside References comments", async () => {
		const { mail, delivered } = await setup(
			mailbox(
				envelope('(("Me" NIL "me" "icloud.com"))'),
				"(copy:<unrelated@x> (nested\\) <z@x>)) <root@x>",
			),
		);
		await mail.send(reply(false));
		expect(delivered[0]?.raw).toContain("References: <root@x> <o@x>\r\n");
	});

	it("asks for recipients instead of guessing when the sender cannot be addressed", async () => {
		const original =
			'("d" "Hi" (("Taro" NIL "taro." "docomo.ne.jp")) NIL NIL (("Me" NIL "me" "icloud.com")(NIL NIL "list" "lists.example")) NIL NIL NIL "<o@x>")';
		const { mail, delivered } = await setup(mailbox(original));
		await expect(mail.send(reply(false))).rejects.toThrow(
			"pass the recipients in to",
		);
		expect(delivered).toEqual([]);
	});

	it("drops a Message-ID that is not one and falls back to In-Reply-To for threading", async () => {
		const original =
			'("d" "Hi" (("Jan" NIL "jan" "example.nl")) NIL NIL NIL NIL NIL "<root@x>" "<o@x>\rBcc: thief@evil.example")';
		const { mail, delivered } = await setup(mailbox(original, ""));
		await mail.send(reply(false));
		const raw = delivered[0]?.raw ?? "";
		expect(raw).not.toContain("thief");
		expect(raw).not.toContain("In-Reply-To");
		expect(raw).toContain("References: <root@x>\r\n");
	});

	it("refuses a reply-all that would address more than 50 people", async () => {
		const many = Array.from(
			{ length: 60 },
			(_, i) => `(NIL NIL "p${i}" "x.nl")`,
		).join("");
		const { mail, delivered } = await setup(mailbox(envelope(`(${many})`)));
		await expect(mail.send(reply(true))).rejects.toThrow("more than 50");
		expect(delivered).toEqual([]);
	});
});

describe("ImapMail.send", () => {
	const draft = {
		to: ["Jan <Jan.de.Vries@Example.nl>"],
		cc: [],
		bcc: ["secret@example.com"],
		subject: "Hi",
		body: "hello",
	};

	it("keeps Bcc out of the delivered message but in the Sent copy", async () => {
		const { server, mail, delivered } = await setup(mailbox(envelope("NIL")));
		const result = await mail.send(draft);
		expect(result.sent_copy).toBe("saved to Sent Messages");
		expect(delivered[0]?.rcpt).toEqual([
			"Jan.de.Vries@Example.nl",
			"secret@example.com",
		]);
		expect(delivered[0]?.raw).not.toContain("Bcc:");
		expect(server.literals[0]).toContain("Bcc: secret@example.com");
		expect(server.literals[0]).toContain(`Message-ID: ${result.message_id}`);
	});

	it("skips the Sent copy when the server already filed one", async () => {
		const { server, mail } = await setup(mailbox(envelope("NIL"), "", true));
		expect((await mail.send(draft)).sent_copy).toBe("already in Sent Messages");
		expect(server.commands.some((c) => c.startsWith("APPEND"))).toBe(false);
	});

	it("passes on a send that may have gone through without touching Sent", async () => {
		const server = await fakeImap(mailbox(envelope("NIL")));
		const session = server.session();
		cleanups.push(() => session.close(), server.close);
		const mail = new ImapMail(session, config, async () => {
			throw new MaybeSentError(new Error("SMTP connection closed"));
		});
		await expect(mail.send(draft)).rejects.toBeInstanceOf(MaybeSentError);
		expect(server.commands).toEqual([]);
	});
});

describe("ImapMail reads and moves", () => {
	const summary = (uid: number) =>
		`* ${uid} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "24-Oct-2026 09:15:00 +0200" ENVELOPE ${envelope("NIL")} BODYSTRUCTURE ${PLAIN})\r\n`;

	it("searches newest first in pages and switches to UTF-8 for non-ASCII terms", async () => {
		const { server, mail } = await setup((command) => {
			if (command.startsWith("UID SEARCH"))
				return { untagged: "* SEARCH 1 5 3 9\r\n" };
			if (command.startsWith("UID FETCH"))
				return { untagged: summary(5) + summary(3) };
			return undefined;
		});
		const result = await mail.search(
			"INBOX",
			{ from: "Zoë", since: new Date("2026-10-01") },
			{ offset: 1, limit: 2 },
		);
		expect(result.total).toBe(4);
		expect(result.messages.map((m) => m.uid)).toEqual([5, 3]);
		expect(result.messages[0]).toMatchObject({
			date: "2026-10-24T09:15:00+02:00",
			from: ["Jan <jan@example.nl>"],
			unread: false,
		});
		expect(server.commands).toContain(
			"UID FETCH 5,3 (UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE)",
		);
		expect(server.commands.find((c) => c.startsWith("UID SEARCH"))).toBe(
			"UID SEARCH CHARSET UTF-8 FROM {4}",
		);
		expect(server.literals).toEqual(["Zoë"]);
	});

	it("reads with EXAMINE and BODY.PEEK and reports truncation", async () => {
		const { server, mail } = await setup((command) => {
			if (command.includes("BODYSTRUCTURE")) return { untagged: summary(7) };
			if (command.includes("BODY.PEEK[1]")) {
				return { untagged: "* 7 FETCH (UID 7 BODY[1] {5}\r\nhello)\r\n" };
			}
			return undefined;
		});
		const message = await mail.read("INBOX", 7, 3);
		expect(message).toMatchObject({ text: "hel", truncated: true });
		expect(server.commands[0]).toBe('EXAMINE "INBOX"');
		expect(server.commands.filter((c) => /BODY\[/.test(c))).toEqual([]);
	});

	it("names special mailboxes by flag, then by their usual name", async () => {
		const { mail } = await setup((command) => {
			if (command.startsWith("LIST")) {
				return {
					untagged: [
						'* LIST () "/" "INBOX"\r\n',
						'* LIST (\\Trash) "/" "Bin"\r\n',
						'* LIST () "/" "Deleted Messages"\r\n',
						'* LIST () "/" "Sent Messages"\r\n',
						'* LIST (\\Noselect) "/" "Folders"\r\n',
					].join(""),
				};
			}
			if (command.startsWith("STATUS")) {
				const name = /"([^"]+)"/.exec(command)?.[1] ?? "";
				return { untagged: `* STATUS "${name}" (MESSAGES 2 UNSEEN 1)\r\n` };
			}
			return undefined;
		});
		expect(await mail.listMailboxes()).toEqual([
			{ name: "INBOX", special_use: "inbox", messages: 2, unread: 1 },
			{ name: "Bin", special_use: "trash", messages: 2, unread: 1 },
			{ name: "Deleted Messages", messages: 2, unread: 1 },
			{ name: "Sent Messages", special_use: "sent", messages: 2, unread: 1 },
		]);
	});

	it("fetches text within one budget and marks a partial body truncated", async () => {
		const big =
			'("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 3000000 1 NIL NIL NIL NIL)';
		const { server, mail } = await setup((command) => {
			if (command.includes("BODYSTRUCTURE")) {
				return {
					untagged: `* 7 FETCH (UID 7 FLAGS () ENVELOPE ${envelope("NIL")} BODYSTRUCTURE (${PLAIN}${big} "mixed" NIL NIL NIL NIL))\r\n`,
				};
			}
			if (command.includes("BODY.PEEK[1]")) {
				return {
					untagged:
						"* 7 FETCH (UID 7 BODY[1] {5}\r\nhello BODY[2]<0> {3}\r\nbye)\r\n",
				};
			}
			return undefined;
		});
		const message = await mail.read("INBOX", 7, 1000);
		expect(message).toMatchObject({ text: "hello\n\nbye", truncated: true });
		expect(server.commands).toContain(
			`UID FETCH 7 (UID BODY.PEEK[1] BODY.PEEK[2]<0.${2 * 1024 * 1024 - 5}>)`,
		);
	});

	it("moves once with the COPY fallback and names a missing destination", async () => {
		let copies = 0;
		const { mail } = await setup((command) => {
			if (command.startsWith("UID SEARCH UID"))
				return { untagged: "* SEARCH 1 2\r\n" };
			if (command.startsWith("UID COPY")) {
				copies++;
				return command.includes('"Nope"')
					? { status: "NO [TRYCREATE] no such mailbox" }
					: "drop";
			}
			return undefined;
		}, "IMAP4rev1 UIDPLUS");
		await expect(mail.move("INBOX", [1, 2, 3], "Nope")).rejects.toThrow(
			'No mailbox named "Nope"',
		);
		// A connection lost after COPY must not copy again.
		await expect(mail.move("INBOX", [1, 2], "Archive")).rejects.toThrow(
			"IMAP connection lost",
		);
		expect(copies).toBe(2);
	});
});
