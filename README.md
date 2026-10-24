# icloud-mcp

An MCP server for iCloud Mail. It gives an AI assistant tools to search, read, file, draft, and send mail on your own iCloud account over IMAP and SMTP.

The IMAP, SMTP, and MIME code is written here, so the only runtime dependencies are the MCP TypeScript SDK v2 and zod. Runs on [Bun](https://bun.sh) 1.4+. It works with any IMAP server that supports `MOVE` or `UIDPLUS`; the defaults point at iCloud.

## Setup

1. Create an app-specific password at [account.apple.com](https://account.apple.com) under Sign-In and Security. iCloud rejects your normal Apple Account password over IMAP.
2. Install:

```sh
git clone https://github.com/sebastiaan-john/icloud-mcp
cd icloud-mcp
bun install
```

Claude Desktop, Claude Code, Cursor, and other stdio hosts:

```json
{
	"mcpServers": {
		"icloud": {
			"command": "bun",
			"args": ["/path/to/icloud-mcp/src/index.ts"],
			"env": {
				"ICLOUD_EMAIL": "you@icloud.com",
				"ICLOUD_APP_PASSWORD": "abcd-efgh-ijkl-mnop"
			}
		}
	}
}
```

If the host cannot find `bun`, use its full path, for example `~/.bun/bin/bun`.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ICLOUD_EMAIL` | required | Your @icloud.com (or @me.com, @mac.com) address. IMAP logs in with the part before the @, SMTP with the whole address, as Apple documents |
| `ICLOUD_APP_PASSWORD` | required | The app-specific password |
| `ICLOUD_FROM` | `ICLOUD_EMAIL` | Sender for outgoing mail, e.g. `Sebastiaan <me@mydomain.com>` for a name or a custom-domain alias |
| `ICLOUD_IMAP_HOST`, `ICLOUD_IMAP_PORT` | `imap.mail.me.com`, `993` | IMAP over TLS |
| `ICLOUD_SMTP_HOST`, `ICLOUD_SMTP_PORT` | `smtp.mail.me.com`, `587` | SMTP; 465 means TLS from the start, any other port requires STARTTLS |
| `ICLOUD_HTTP_PORT` | unset | Serve Streamable HTTP on this port instead of stdio |
| `ICLOUD_HTTP_HOST` | `127.0.0.1` | Bind address for HTTP mode |
| `ICLOUD_HTTP_TOKEN` | unset | Token every HTTP request must carry; required (16+ characters) whenever HTTP is on |

Empty values count as unset.

### HTTP mode and Grok

```sh
export ICLOUD_HTTP_TOKEN=$(openssl rand -hex 24); echo "$ICLOUD_HTTP_TOKEN"
ICLOUD_HTTP_PORT=3000 ICLOUD_EMAIL=you@icloud.com ICLOUD_APP_PASSWORD=... bun src/index.ts
```

The endpoint is `/mcp`. Requests need `Authorization: Bearer <token>`; a bare token without `Bearer` is accepted too, because xAI's docs do not say whether its `authorization` field adds the prefix. Bind to anything other than 127.0.0.1 only behind TLS, since the token travels in every request. The token is the only access control. It also stops browser pages from reaching the server through DNS rebinding, since they do not know it.

xAI's API connects to remote MCP servers itself rather than through your machine, so the endpoint has to be reachable over public HTTPS, for example through Tailscale Funnel or a Cloudflare Tunnel in front of port 3000. Then add it to a request:

```json
"tools": [
	{
		"type": "mcp",
		"server_url": "https://mail.example.com/mcp",
		"server_label": "icloud",
		"authorization": "<ICLOUD_HTTP_TOKEN>",
		"allowed_tools": ["mail_list_mailboxes", "mail_search", "mail_read", "mail_get_attachment", "mail_update_flags", "mail_move", "mail_save_draft"]
	}
]
```

That `allowed_tools` list leaves out `mail_send`, so the bot can draft replies but you send them from Mail. Drop the list to allow everything.

## Tools

Messages are addressed by mailbox name plus UID. `mail_search` returns UIDs; a UID stays valid while the message stays in its mailbox.

| Tool | Does |
|---|---|
| `mail_list_mailboxes` | Mailboxes with message and unread counts, and which is inbox, sent, drafts, trash, junk, or archive |
| `mail_search` | Newest-first search in one mailbox by text, sender, recipient, subject, date range, read and flagged state, with paging |
| `mail_read` | One message: headers, the body as text (HTML converted, links kept, hidden text dropped), and its attachments. Does not mark it read |
| `mail_get_attachment` | One attachment up to 10 MB: images as images, text as text, anything else as a base64 resource |
| `mail_update_flags` | Mark read or unread, flag or unflag |
| `mail_move` | Move to another mailbox; deleting is a move to the trash mailbox |
| `mail_save_draft` | Save a plain-text message or reply to Drafts |
| `mail_send` | Send a plain-text message or reply, then file a copy in Sent |

Replies take `reply_to_uid`: the server fills in `In-Reply-To`, `References`, the `Re:` subject, and the recipients (`reply_all` copies everyone else on the original, up to 50 people in total), and marks the original answered after sending. Addresses must be ASCII; the server does not use SMTPUTF8.

Email comes from strangers, and an assistant reading it can be steered by what it says. The server instructions tell the model to treat message content as data, `mail_read` drops text hidden with CSS, and `mail_send` is the one tool that acts outside the mailbox. For an unattended bot, leave `mail_send` out of `allowed_tools` so it can only draft.

Sending cannot be undone, and the tool description tells the model to confirm with you first. If the SMTP connection drops after the message was handed over, the error says it may have been sent and to check Sent before retrying. iCloud may or may not file SMTP mail in Sent by itself, so after sending the server looks for the Message-ID in Sent and appends a copy, Bcc included, only when it is missing.

No tool deletes mail permanently; deleting means moving to the trash mailbox, from where you can still restore it.

## Development

```sh
bun run check   # oxlint, oxfmt --check, tsc, bun test
bun run lint    # fix and format
```

Tests are colocated as `*.test.ts`. The server tests drive the real MCP handler through `@modelcontextprotocol/client` with a fake mailbox; the session and mail tests run the real IMAP client against a scripted server on a local socket (`src/imap/fake-server.ts`). Nothing in the suite talks to a real mail server.

The MCP Inspector does not inherit your shell environment, so pass the variables explicitly:

```sh
bunx @modelcontextprotocol/inspector -e ICLOUD_EMAIL=you@icloud.com -e ICLOUD_APP_PASSWORD=... bun src/index.ts
```

Not affiliated with Apple. MIT, see [LICENSE](LICENSE).
