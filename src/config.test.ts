import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config";

const base = {
	ICLOUD_EMAIL: "me@icloud.com",
	ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop",
};

describe("loadConfig", () => {
	it("uses iCloud's servers and the name part of the address for IMAP", () => {
		const config = loadConfig({
			...base,
			ICLOUD_FROM: "",
			ICLOUD_HTTP_PORT: "",
		});
		expect(config.imap).toEqual({
			host: "imap.mail.me.com",
			port: 993,
			user: "me",
			password: "abcd-efgh-ijkl-mnop",
		});
		expect(config.smtp).toMatchObject({
			host: "smtp.mail.me.com",
			port: 587,
			user: "me@icloud.com",
		});
		expect(config.from).toBe("me@icloud.com");
		expect(config.http).toBeUndefined();
	});

	it("requires a token whenever HTTP is on", () => {
		expect(() => loadConfig({ ...base, ICLOUD_HTTP_PORT: "3000" })).toThrow(
			"ICLOUD_HTTP_TOKEN",
		);
		const config = loadConfig({
			...base,
			ICLOUD_HTTP_PORT: "3000",
			ICLOUD_HTTP_TOKEN: "0123456789abcdef",
		});
		expect(config.http).toEqual({
			port: 3000,
			host: "127.0.0.1",
			token: "0123456789abcdef",
		});
	});

	it("logs in with the Apple address and sends from a custom domain", () => {
		expect(() =>
			loadConfig({ ...base, ICLOUD_EMAIL: "hello@example.nl" }),
		).toThrow("ICLOUD_FROM");
		const config = loadConfig({ ...base, ICLOUD_FROM: "hello@example.nl" });
		expect(config.imap.user).toBe("me");
		expect(config.from).toBe("hello@example.nl");
	});

	it("names the missing and invalid variables", () => {
		expect(() =>
			loadConfig({ ICLOUD_EMAIL: "nope", ICLOUD_FROM: "not an address" }),
		).toThrow(/ICLOUD_EMAIL[\s\S]*ICLOUD_APP_PASSWORD[\s\S]*ICLOUD_FROM/);
	});
});
