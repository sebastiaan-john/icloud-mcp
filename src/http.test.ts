import {
	LATEST_PROTOCOL_VERSION,
	McpServer,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "bun:test";
import { serveHttp } from "./http";

const token = "a-sufficiently-long-token";
const factory = () => new McpServer({ name: "t", version: "0" });
const initialize = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
};
const noop = async () => {};

describe("serveHttp", () => {
	let close: () => Promise<void> = noop;
	afterEach(() => close());

	it("requires the token on every path, with or without Bearer, and serves only /mcp", async () => {
		const http = serveHttp(factory, { port: 0, host: "127.0.0.1", token });
		close = http.close;
		const post = (path: string, headers: Record<string, string>) =>
			fetch(new URL(path, http.url), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...headers,
				},
				body: JSON.stringify(initialize),
			});
		const status = async (path: string, authorization?: string) =>
			(await post(path, authorization ? { authorization } : {})).status;

		const anonymous = await post("/mcp", {});
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
		expect(await status("/mcp", `Bearer ${token.replace("a", "b")}`)).toBe(401);
		expect(await status("/mcp", `Bearer ${token}x`)).toBe(401);
		expect(await status("/mcp", "Bearer ")).toBe(401);
		expect(await status("/anything")).toBe(401);
		expect(await status("/other", `Bearer ${token}`)).toBe(404);
		// xAI's remote MCP sends its `authorization` value as is.
		expect(await status("/mcp", token)).toBe(200);

		const ok = await post("/mcp", { authorization: `bearer ${token}` });
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain('"serverInfo"');
	});
});
