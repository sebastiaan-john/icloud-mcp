# icloud-mcp

MCP server (SDK v2, `@modelcontextprotocol/server`) exposing an iCloud Mail account over IMAP and SMTP. Bun only; there is no build step. IMAP, SMTP, and MIME are implemented in `src/`; do not add mail libraries.

## Commands

- `bun run check` runs oxlint, oxfmt --check, tsc, and bun test. Run it before every commit.
- `bun run lint` fixes lint and formats (tabs, 80 columns, sorted imports).

## Layout

- `src/index.ts` picks stdio or HTTP from the config and wires the session.
- `src/config.ts` parses env with zod; the only place env is read.
- `src/imap/wire.ts` response framing (literals included), tokenizer, argument quoting, modified UTF-7. Pure.
- `src/imap/connection.ts` one socket: tagged commands, synchronizing literals, pipelined batches, timeouts. `ImapCommandError` is a NO/BAD on a live connection; `ImapConnectionError` means the socket is gone.
- `src/imap/session.ts` `ImapClient` (login, capabilities, selected mailbox) and `ImapSession`, which owns the single connection, serializes calls, retries a call once when a reused connection is dead, and closes it after 5 idle minutes.
- `src/imap/structure.ts` ENVELOPE and BODYSTRUCTURE into typed trees; which parts are body text and which are attachments.
- `src/mime/decode.ts` encoded words, RFC 2231 parameters, transfer encodings, charsets, HTML to text. `src/mime/compose.ts` builds outgoing text/plain messages.
- `src/smtp.ts` one-shot SMTP send: STARTTLS (or TLS on 465), AUTH PLAIN, dot-stuffing.
- `src/mail.ts` the `Mail` interface the tools use and `ImapMail`, its implementation.
- `src/tools/*.ts` tool registration, grouped as read, organize, compose.

## Rules

- stdout is the MCP channel on stdio. Log with `console.error` only.
- Tools return compact `json(...)` text and throw plain `Error`s; the SDK turns them into `isError` results. Error messages say what to call next.
- Reads use `EXAMINE` and `BODY.PEEK` so nothing marks mail read as a side effect.
- Pass `{ retry: false }` to `session.run` for anything that must not apply twice (APPEND). Sends go through SMTP once; a failure after DATA becomes `MaybeSentError`.
- Every user string that reaches IMAP goes through `str` or `mailboxArg`; part numbers are validated by the tool schema before they reach `BODY[...]`. Header values never contain CR or LF.
- Every tool carries `annotations` and every argument a `.describe()`; the server test enforces both.
- Tests use fakes injected through `Mail` or the session's `connect` factory, never module mocks, and never call a real mail server.
