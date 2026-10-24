import {
	createMcpHandler,
	type McpServerFactory,
} from "@modelcontextprotocol/server";
import { timingSafeEqual } from "node:crypto";
import type { HttpConfig } from "./config";

/** Accepts `Bearer <token>` and a bare token, since some MCP hosts send the configured value as is. */
function bearerMatches(header: string | null, token: string): boolean {
	const value = header?.trim() ?? "";
	const provided = /^bearer\s+(.+)$/i.exec(value)?.[1] ?? value;
	const a = Buffer.from(provided);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Serves /mcp over Streamable HTTP. Every request must carry the bearer
 * token, which also covers DNS rebinding and other cross-site attacks: a page
 * in a browser does not know it.
 */
export function serveHttp(factory: McpServerFactory, http: HttpConfig) {
	const handler = createMcpHandler(factory, {
		onerror: (error) => console.error("[icloud-mcp] http:", error.message),
	});
	const server = Bun.serve({
		hostname: http.host,
		port: http.port,
		fetch(request) {
			if (!bearerMatches(request.headers.get("authorization"), http.token)) {
				return new Response(null, {
					status: 401,
					headers: { "www-authenticate": "Bearer" },
				});
			}
			if (new URL(request.url).pathname !== "/mcp") {
				return new Response(null, { status: 404 });
			}
			// IMAP and SMTP calls can outlast Bun's 10 s idle timeout; lift it only once the
			// caller is authenticated, so idle anonymous sockets still get closed.
			server.timeout(request, 0);
			return handler.fetch(request);
		},
	});
	return {
		url: new URL("/mcp", server.url),
		async close() {
			await handler.close();
			await server.stop(true);
		},
	};
}
