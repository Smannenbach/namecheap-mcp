# Changelog

## Unreleased — Smannenbach maintained fork

### Registrar state and mutation safety

- `get_domain_info` now combines an exact-match `domains.getList` result, `domains.getInfo`, and the dedicated `domains.getRegistrarLock` endpoint. Missing state is `null`, and the list-level lock is exposed separately from authoritative transfer lock.
- `set_registrar_lock` now requires explicit approval, validates `IsSuccess`, and requires a matching dedicated post-write readback.
- `set_domain_autorenew` now fails closed with zero provider calls because Namecheap publishes no domain auto-renew mutation command.
- Domain privacy parsing supports documented child elements and legacy/current attribute variants. Privacy enable requires the documented forwarding email; enable, disable, and renewal validate provider acknowledgement and exact-domain readback.
- Every active provider mutation tool now requires a literal confirmation input.

### Local runtime and verification

- Clean Windows installs no longer fail on the Unix-only `chmod` build step.
- A sanitized `smoke:readonly` command verifies the built MCP server and authoritative registrar sources without exposing credentials or changing provider state.
- Dependency resolution is updated to a zero-finding `npm audit`, and the snapshot permission test now handles Windows filesystem mode semantics.

## [1.5.0] — 2026-04-21

### Dependency upgrades

Every runtime and type dependency has been brought current. No user-visible behaviour changes; the version bump reflects the `zod` major.

- **`zod` 3.x → 4.3.6** — zod 4 is a major version with a rewritten core (2.5–6.5× faster parsing, smaller bundle, new `error` parameter replacing `message`/`invalid_type_error`/`errorMap`). The namecheap-mcp schema surface is small — the only required code change was `.refine({ message, path })` → `.refine({ error, path })` in `set_dns_hosts`. All 34 tool schemas render identically to the MCP client.
- **`@types/node` 20 → 25.6.0** — catches up with Node 24 LTS defaults. No code changes required.
- **`dotenv` 16 → 17.4.2** — minor. No code changes required.
- **`fast-xml-parser` 5.5.7 → 5.7.1** — patch. No code changes required.

TypeScript stays on 5.x for now; a 6.0 bump is a separate piece of work.

### Fixed (from v1.4.3 review)

- **`pruneSnapshots` retry-count comment clarified** — code does 3 retries (4 total HTTP calls), not "3 attempts" as the original comment read.
- **`REQUIRED_KEYS` de-duplicated** — `auth_status.ts` and `setup.ts` now both import `REQUIRED_CREDENTIAL_KEYS` from `config.ts`. A future credential addition picks up in both tools automatically.
- **`detectPublicIp` now caches for 60s** — `auth_status` can be called repeatedly without repeating the ipify lookup (and a failed lookup is cached too so a down ipify doesn't add 2s to every call in the TTL window).

## [1.4.3] — 2026-04-21

### Reliability

- **Snapshot pruning is now race-safe.** `pruneSnapshots` takes an advisory `mkdir` lock per domain before listing and deleting; concurrent writers skip pruning (the next writer catches up) instead of racing `listSnapshots` + `unlink`. Stale locks (older than 60s — far beyond any real prune) self-reclaim on the next attempt. Unlink ENOENT is tolerated.
- **Rate-limit backoff is now exponential.** Previously a single 1s retry on HTTP 429. Now 3 attempts with 1s / 2s / 4s waits (7s total cap). Applies to both GET and POST — rapid multi-record upsert scripts no longer blow past the limit.
- **`update_dns_record` delete on a missing record is now a clean no-op.** No API round-trip, no post-write verification, explicit `result: "no-op"` in the response. Saves a call on idempotent cleanup scripts.

### Diagnostics

- **`auth_status` now includes the current public IP.** `currentPublicIp` is looked up via ipify with a 2s timeout, and `ipMatchesConfigured` tells you whether it equals `NAMECHEAP_CLIENT_IP`. Resolves the error 1011102 ambiguity (bad key vs unwhitelisted IP) on the spot. Extra hint surfaces when current IP does not match configured.
- **`setup` form now warns about split-source credentials.** If the elicitation is opened while `NAMECHEAP_*` credentials are split between a shell export and a config file, the form message explains that the shell export will still shadow the saved file value, and tells the user to unset the export + restart Claude Code.
- **Raw XML dump on parser failure, gated on `NAMECHEAP_DEBUG=1`.** If `parseGetHostsResponse` throws, the last 2KB of the raw Namecheap XML body is written to stderr. Exposed via a new `NamecheapClient.lastRawResponse` getter. Makes future API-schema-shift incidents diagnosable without a manual curl re-run.

### Fixed

- **`restore_dns_snapshot` reports a specific `SNAPSHOT_READ_FAILED` error** when the snapshot file is missing, truncated, or from an unsupported schema version. Previously any `readSnapshot` throw surfaced as a generic `UNKNOWN` error.

## [1.4.2] — 2026-04-20

### Fixed — multi-value DNS records no longer clobber each other

`update_dns_record`'s matching predicate only address-matched MX records. Upserting a second TXT at the same hostName (e.g. adding an `openai-verification` TXT at `@` when SPF and `google-site-verification` were already there) silently replaced one of the existing records. Same class of bug was latent for CAA and NS.

- Matching logic now lives in `src/dns-matching.ts` as a pure `recordMatches` function. Unit-testable, used by `update_dns_record`.
- Records of type **MX, TXT, CAA, or NS** at the same `(hostName, recordType)` tuple are now matched on `address` — so distinct bodies at the same host coexist instead of clobbering.
- Single-value types (A, AAAA, CNAME, ALIAS, etc.) keep their existing replace-in-place upsert semantics.
- `delete` with no `address` still matches all records of the type at the hostName (bulk-delete semantics preserved).
- New `tests/unit/dns-matching.test.ts` covers multi-TXT survival, CAA parity, MX regression, NS, and delete-all-at-host.

### Fixed — version drift between `package.json` and MCP metadata

`src/index.ts` was hardcoding `version: '1.3.2'` in the `McpServer` constructor, already out of sync with the shipped `package.json`. Now read from `package.json` at runtime via `createRequire` — the diagnostic output cannot lie again.

### Migration

No caller-visible API changes. Existing `update_dns_record` calls on single-value types behave identically. Multi-TXT workflows that previously relied on the clobber behavior will now append instead; if you genuinely want to replace an SPF or similar multi-value record, do `operation:'delete'` with the old address followed by `operation:'upsert'` with the new.

## [1.4.1] — 2026-04-20

### Fixed — the actual root cause of the zone-wipe bug

Captured a live Namecheap `getHosts` XML response mid-incident and discovered the API returns `<host>` **lowercase**, while `ARRAY_TAGS` in `src/client.ts` and `parseGetHostsResponse` in `src/parse.ts` looked for `Host` (capital). `envelope['Host']` was always `undefined`, `parseHosts` always returned `[]`, and every downstream `set_dns_hosts` replaced a zone the LLM believed was empty — wiping all records in a single call. This had been the case since v1.0.

- `ARRAY_TAGS` now includes both `host` and `Host` for defensive parity.
- `parseGetHostsResponse` reads `envelope['host']` first with `Host` as a fallback.
- Regression test using the captured real-world XML shape added to `tests/unit/parse.test.ts`.

### Notes

The v1.4.0 hardening (snapshot-before-write, empty-baseline guard, `confirmReplaceAll` gates, post-write verify) stays in place. Defense in depth: v1.4.1 fixes the root parser bug that was triggering v1.4.0's guards on every read.

## [1.4.0] — 2026-04-20

### Fixed — DNS zone-wipe prevention (CRITICAL)

The underlying Namecheap `namecheap.domains.dns.setHosts` API is a full-replacement operation: any record not included in the call is deleted. Prior behaviour around this was too easy to misuse:

- `parseHosts` silently returned `[]` on any unexpected response shape. If `update_dns_record` received a bad parse, it would proceed with an empty baseline and write only the new record via `setHosts`, **wiping the entire zone**.
- `set_dns_hosts` was a thin passthrough. An LLM (or user) that skipped the "DESTRUCTIVE" warning could call it with a single record and wipe the zone.

v1.4.0 eliminates both footguns:

- **Strict parser**: `parseGetHostsResponse` (new `src/parse.ts`) throws on missing `DomainDNSGetHostsResult` envelope or malformed `Host` elements. No more silent `[]` fallback.
- **Empty-baseline guard**: `update_dns_record` now refuses by default when the pre-write read returns 0 records on a zone using Namecheap DNS. Override with `allowEmptyBaseline: true` only for legitimate first-time adds to a freshly provisioned empty zone.
- **`set_dns_hosts` is gated**: requires `confirmReplaceAll: true` **and** `expectedDeletions: <number>` matching a pre-write diff. Any mismatch is refused with a snapshot path for recovery.
- **`set_email_forwarding` gated** on `confirmReplaceAll: true`.
- **Post-write verification**: both `set_dns_hosts` and `update_dns_record` re-read the zone after writing and diff against the expected record count; mismatches surface a warning with the pre-write snapshot path.
- **`EmailType` preserved** across round-trips in `update_dns_record` and `set_dns_hosts` (read from `getHosts`, passed through on `setHosts`).

### Added — DNS zone snapshots

- **Automatic local backups**: every `get_dns_hosts` read and every `setHosts` write produces a JSON snapshot at `~/.config/namecheap-mcp/snapshots/<domain>__<timestamp>-<rand>.json` (mode `0600`). Retention: 50 most-recent per domain.
- **`list_dns_snapshots`** tool — lists snapshots for a domain, newest first.
- **`restore_dns_snapshot`** tool — replaces the current zone with a snapshot's record set (gated on `confirmReplaceAll: true`; takes a pre-restore snapshot first so the operation is itself reversible).

### Added — Record type coverage

- `RECORD_TYPES` enum extended with `ALIAS`, `CAA`, and `MXE`. These types were previously rejected by zod even though Namecheap supports them; existing records of these types now round-trip cleanly.

### Added — Test suite

- `vitest` dev dependency + `npm test` / `npm run test:watch` scripts.
- Unit tests under `tests/unit/` covering the strict parser (including every throw path), snapshot read/write/list/prune, and `splitDomain` + `flattenHostRecords`.

### Migration notes

- Existing calls to `set_dns_hosts` without `confirmReplaceAll`/`expectedDeletions` will now refuse with a message pointing at `update_dns_record`. Update callers that genuinely want a full-zone replace; everything else should be migrated to `update_dns_record`.
- `update_dns_record` on a Namecheap-DNS zone that legitimately has 0 records needs `allowEmptyBaseline: true` — this is a rare case (freshly provisioned empty zone) and the extra friction is the point.

## [1.3.2] — 2026-04-20

### Fixed
- **Shell env no longer silently shadows `.env` file values** (#4). `loadConfig()` previously relied on `dotenv.config()`, which never overrides existing `process.env` keys and treats empty strings as "already set." A shell that exported `NAMECHEAP_API_KEY=""` (or just one of the three required vars) would leave file values unloaded while `auth_status` reported `user-config` as the source — producing `ready:false` with an empty effective value. `loadConfig()` now does an explicit per-key merge that treats empty strings as unset. Precedence is unchanged: non-empty shell/host env > user-config file > project-local `.env`.
- **Orphan MCP processes no longer survive stdin close** (#4). `src/index.ts` now installs explicit `stdin` `end`/`close` and `SIGTERM`/`SIGINT`/`SIGHUP` handlers that `process.exit(0)`. `StdioServerTransport` should close on EOF on its own, but the explicit handlers guarantee dead processes cannot accumulate across Claude Code reconnects.

### Added
- Loud stderr warning on startup when credentials are missing: `[namecheap-mcp] UNCONFIGURED at startup. sources: {...}`. Surfaces the failure immediately instead of waiting for the first tool call.

## [1.3.1] — 2026-04-20

### Added
- `auth_status` now reports the **source of each credential** (`shell`, `user-config`, `project-env`, or `missing`) and a `splitSources` boolean — exposing the footgun where a stale shell-exported `NAMECHEAP_API_KEY` silently shadows the correct value in `~/.config/namecheap-mcp/.env`. Validation failures that stem from split sources produce a specific hint naming the remediation (unset the shell export or make all three required vars come from the same source).

### Notes
- This is a diagnostic-only change. No precedence behavior changed: shell/host env still wins over file (dotenv default). The fix replaces a mystery with a visible explanation.

## [1.3.0] — 2026-04-20

### Added
- `auth_status` tool — reports whether credentials are loaded, whether they were accepted by the Namecheap API, and the last error if any. Returns `structuredContent` with `errorCode`, actionable `hint`, and `recommendedAction`. Use this to diagnose why tools are failing.
- Startup credential validation — on boot, if credentials are present the server pings `namecheap.users.getBalances` once. If the ping fails (bad key, unwhitelisted IP, etc.) the server records the failure and starts in an unconfigured state instead of silently exposing broken tools.
- Dynamic `serverInfo.instructions` — the MCP client sees a different description depending on auth state, pointing unconfigured users directly at `setup`.

### Changed
- **Tool-list gating**: when the server is unconfigured or credentials are invalid, the `/mcp` dialog now shows only two tools (`setup`, `auth_status`) instead of all 32. Once credentials validate, the full tool suite registers and the client receives a `notifications/tools/list_changed` so it refreshes without a reconnect.
- **Structured error payloads**: all tool catch blocks now return `isError: true` with a `structuredContent` body containing `errorCode`, `command`, `isAuthError`, and `isUnconfigured`. Error messages include the Namecheap error code inline (e.g. `Error [1011102]: ...`) and auth-class failures update `auth_status` in place.
- `setup` tool now records auth state and fires `sendToolListChanged()` on success so the full tool list appears immediately.

### Notes
- The MCP protocol's native `/mcp` **Authenticate** button is HTTP/OAuth-transport only (per MCP 2025-06-18). Because namecheap-mcp uses stdio, the supported auth flow is the `setup` tool (elicitation form) or the `/namecheap-mcp:setup` slash command. This release makes that flow much more discoverable.

## [1.2.1] — 2026-04-20

### Added
- Claude Code plugin bundling: `.claude-plugin/plugin.json`, `.mcp.json`, `/namecheap-mcp:setup` slash command, and a launcher script that prefers a global `namecheap-mcp` binary and falls back to the bundled `dist/index.js`. Installable via the `robworks-claude-code-plugins` marketplace.

### Fixed
- Resolved 11 moderate Dependabot advisories by bumping transitive dependencies: `axios` → 1.15.1 (SSRF via NO_PROXY normalization, cloud metadata exfiltration), `follow-redirects` → 1.16.0 (auth header leak on cross-domain redirects), `hono` → 4.12.14 (cookie validation, path traversal, JSX HTML injection, middleware bypass, IP matching), `@hono/node-server` → 1.19.13 (middleware bypass).

## [1.2.0] — 2026-04-03

### Added
- `register_domain` — purchase a new domain with registrant contact info
- `get_domain_contacts` — read WHOIS contact info for a domain
- `set_domain_contacts` — update registrant/tech/admin/billing contacts
- `reactivate_domain` — recover a recently expired domain
- `renew_whoisguard` — renew WHOIS privacy protection independently of domain renewal
- `transfer_domain` — initiate an inbound transfer with EPP code
- `get_transfer_status` — check transfer status by ID
- `list_transfers` — list all transfers, filterable by status
- `get_ssl_info` — get details for a specific SSL certificate
- `activate_ssl` — activate a purchased certificate by submitting a CSR; supports email, HTTP file, and CNAME DCV methods
- `reissue_ssl` — reissue a certificate with a new CSR

### Fixed
- Upgraded `fast-xml-parser` from `^4.4.0` to `^5.5.7` to address a moderate security vulnerability

## [1.1.0] — 2026-03-xx

### Added
- `update_dns_record` — safe single-record add/update/delete (read-modify-write) without affecting other records
- `set_domain_autorenew` — enable or disable auto-renewal
- `set_registrar_lock` — lock or unlock domain transfer
- `set_whoisguard` — enable or disable WHOIS privacy
- `get_pricing` — query pricing for domains, SSL, or Whois Guard
- `get_tld_list` — browse supported TLDs with `search` and `registerable` filters

### Changed
- Cleaned up all tool outputs — structured JSON instead of raw API responses
- `get_domain_info` now returns a flattened, human-readable object

## [1.0.0] — Initial release

- `setup` — interactive credential configuration (MCP elicitation or standalone CLI)
- `check_domains` — availability check for one or more domains
- `list_domains` — paginated domain list with status filtering
- `get_domain_info` — full domain details
- `renew_domain` — renew a domain for 1–10 years
- `get_dns_hosts` — read all DNS records
- `set_dns_hosts` — replace all DNS records
- `set_dns_default` — revert to Namecheap nameservers
- `set_dns_custom` — set custom nameservers
- `get_email_forwarding` / `set_email_forwarding` — email forwarding rules
- `list_ssl_certs` / `create_ssl_cert` — SSL certificate management
- `get_balances` — account balance
