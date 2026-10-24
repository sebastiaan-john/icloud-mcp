import type {
	CallToolResult,
	ToolAnnotations,
} from "@modelcontextprotocol/server";
import * as z from "zod";

/** Compact JSON: a model reads it as well as indented JSON, in fewer tokens. */
export function json(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export const mailboxArg = z
	.string()
	.min(1)
	.default("INBOX")
	.describe(
		"Mailbox name as mail_list_mailboxes returns it; defaults to INBOX",
	);

const uid = z.number().int().min(1).max(4_294_967_295);

export const uidArg = uid.describe(
	"Message UID from mail_search, valid within its mailbox",
);

export const uidsArg = z
	.array(uid)
	.min(1)
	.max(100)
	.describe("Message UIDs from mail_search, all in the same mailbox (1-100)");

export const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	openWorldHint: true,
};

/** A write that can be repeated without changing the outcome. */
export const IDEMPOTENT_WRITE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
