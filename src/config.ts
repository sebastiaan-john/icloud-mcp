import * as z from "zod";
import { parseAddress } from "./mime/compose";

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z
	.object({
		ICLOUD_EMAIL: z.email(),
		ICLOUD_APP_PASSWORD: z.string().trim().min(1),
		ICLOUD_FROM: z
			.string()
			.refine(
				(v) => parseAddress(v) !== undefined,
				"Expected user@host or Name <user@host>",
			)
			.optional(),
		ICLOUD_IMAP_HOST: z.string().default("imap.mail.me.com"),
		ICLOUD_IMAP_PORT: port.default(993),
		ICLOUD_SMTP_HOST: z.string().default("smtp.mail.me.com"),
		ICLOUD_SMTP_PORT: port.default(587),
		ICLOUD_HTTP_PORT: port.optional(),
		ICLOUD_HTTP_HOST: z.string().default("127.0.0.1"),
		ICLOUD_HTTP_TOKEN: z.string().trim().min(16).optional(),
	})
	.refine(
		(e) =>
			e.ICLOUD_HTTP_PORT === undefined || e.ICLOUD_HTTP_TOKEN !== undefined,
		{
			message: "Required (16+ characters) whenever ICLOUD_HTTP_PORT is set",
			path: ["ICLOUD_HTTP_TOKEN"],
		},
	)
	.transform((e) => ({
		/** Sender for outgoing mail, and the address left out of reply-all. */
		from: e.ICLOUD_FROM ?? e.ICLOUD_EMAIL,
		imap: {
			host: e.ICLOUD_IMAP_HOST,
			port: e.ICLOUD_IMAP_PORT,
			// iCloud IMAP takes the name part of the address; SMTP takes all of it.
			user: e.ICLOUD_EMAIL.split("@")[0]!,
			password: e.ICLOUD_APP_PASSWORD,
		},
		smtp: {
			host: e.ICLOUD_SMTP_HOST,
			port: e.ICLOUD_SMTP_PORT,
			user: e.ICLOUD_EMAIL,
			password: e.ICLOUD_APP_PASSWORD,
		},
		/** Present when the server should listen on Streamable HTTP instead of stdio. */
		http:
			e.ICLOUD_HTTP_PORT !== undefined && e.ICLOUD_HTTP_TOKEN !== undefined
				? {
						port: e.ICLOUD_HTTP_PORT,
						host: e.ICLOUD_HTTP_HOST,
						token: e.ICLOUD_HTTP_TOKEN,
					}
				: undefined,
	}));

export type Config = z.output<typeof envSchema>;
export type ImapConfig = Config["imap"];
export type HttpConfig = NonNullable<Config["http"]>;

/**
 * Parses environment variables into the server configuration. Empty values
 * count as unset, since some hosts write `KEY=` for every optional variable.
 * Throws a readable error naming the invalid variables.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
	const present = Object.fromEntries(
		Object.entries(env).filter(([, v]) => v !== ""),
	);
	const parsed = envSchema.safeParse(present);
	if (!parsed.success) {
		throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}
