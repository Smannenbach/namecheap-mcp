# namecheap-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [Namecheap API](https://www.namecheap.com/support/api/intro/), giving AI assistants the ability to manage domains, DNS records, SSL certificates, and account information directly from your conversations.

## Features

- **Domains** — check availability, register, list, renew, reactivate, manage contacts and privacy
- **DNS** — read and write host records (A, AAAA, CNAME, MX, TXT, NS), safe single-record updates, set custom or default nameservers
- **Email Forwarding** — get and set per-domain forwarding rules
- **SSL** — list, purchase, activate, reissue certificates; full DCV support (email, HTTP, CNAME)
- **Transfers** — initiate inbound transfers, track status, list all transfers
- **Account** — check balances, query pricing
- **TLD Browser** — search available TLDs with filtering by name or registerability
- **Interactive Setup** — configure credentials via an in-editor form or a standalone CLI tool

## Requirements

- Node.js 18+
- A [Namecheap account](https://www.namecheap.com) with API access enabled
- Your public IP [whitelisted](https://ap.www.namecheap.com/settings/tools/apiaccess/) in the Namecheap dashboard

## Installation

See [INSTALL.md](./INSTALL.md) for full setup instructions.

### Quick start (npx — no install needed)

```json
{
  "mcpServers": {
    "namecheap": {
      "command": "npx",
      "args": ["-y", "namecheap-mcp"]
    }
  }
}
```

### Global install

```bash
npm install -g namecheap-mcp
```

```json
{
  "mcpServers": {
    "namecheap": {
      "command": "namecheap-mcp"
    }
  }
}
```

## Setup

Credentials are stored globally at `~/.config/namecheap-mcp/.env` and are picked up automatically by any project using this server — you only need to configure once per machine.

### Option 1: In-editor form (Claude Code ≥ 2.1.76)

Call the `setup` tool from within Claude Code. A form will appear prompting for your credentials. Your public IP is auto-detected as a default.

> **Tip:** Submit the form promptly — the request will time out if left idle. If it times out, just call `setup` again.

### Option 2: Interactive CLI

```bash
namecheap-mcp-setup
```

### Option 3: Environment variables

| Variable | Description |
|---|---|
| `NAMECHEAP_API_USER` | Your Namecheap username |
| `NAMECHEAP_API_KEY` | API key (Account → Profile → Tools → API Access) |
| `NAMECHEAP_CLIENT_IP` | Whitelisted public IP address |
| `NAMECHEAP_USERNAME` | Account username if different from API user (optional) |
| `NAMECHEAP_SANDBOX` | `true` to use the sandbox API (optional) |

### Why isn't there an "Authenticate" button in `/mcp`?

Claude Code's native **Authenticate** button in the `/mcp` dialog is part of the MCP 2025-06-18 HTTP+OAuth handshake, which only applies to HTTP-transport servers. namecheap-mcp uses stdio transport, so the button never appears for it. The supported auth flows are the `setup` elicitation tool (Option 1 above), the `namecheap-mcp-setup` CLI (Option 2), or the `/namecheap-mcp:setup` slash command.

To help you tell at a glance whether the server is actually authenticated, namecheap-mcp hides its full tool suite until credentials validate. If you see only `setup` and `auth_status` in `/mcp`, the server is not yet authenticated — run `setup`. Call `auth_status` anytime to see a full diagnostic (error code, whitelisted IP, config file path, and a recommended next action).

## Tools

### Domains

| Tool | Description |
|---|---|
| `setup` | Configure credentials interactively |
| `check_domains` | Check availability of one or more domains |
| `register_domain` | Purchase a new domain |
| `list_domains` | List all domains in your account (paginated, filterable); exposes the provider's list-level change lock separately, not as transfer-lock authority |
| `get_domain_info` | Full details combined from exact-match domain list, domain info, and the dedicated registrar-lock endpoint |
| `get_domain_contacts` | Read WHOIS contact info (registrant, tech, admin, billing) |
| `set_domain_contacts` | Update WHOIS contact info |
| `renew_domain` | Renew a domain for 1–10 years |
| `reactivate_domain` | Reactivate a recently expired domain |
| `get_tld_list` | Browse supported TLDs; filter by name or registerability |
| `set_domain_autorenew` | Compatibility-only fail-closed response; makes zero provider calls because Namecheap publishes no auto-renew mutation command |
| `set_registrar_lock` | Lock or unlock domain transfer; requires explicit confirmation, provider acknowledgement, and dedicated post-write readback |
| `set_whoisguard` | Enable or disable domain privacy; enable also requires a forwarding email, and both paths require explicit confirmation plus post-write readback |
| `renew_whoisguard` | Renew WHOIS privacy protection |

### DNS

| Tool | Description |
|---|---|
| `get_dns_hosts` | Read all DNS records for a domain (also writes a local backup snapshot) |
| `update_dns_record` | Safely add, update, or remove a single DNS record (recommended) |
| `set_dns_hosts` | Replace all DNS records — **gated** behind `confirmReplaceAll` + `expectedDeletions` |
| `set_dns_default` | Revert to Namecheap's default nameservers |
| `set_dns_custom` | Delegate DNS to external nameservers (e.g. Cloudflare) |
| `get_email_forwarding` | Read email forwarding rules |
| `set_email_forwarding` | Replace email forwarding rules — gated behind `confirmReplaceAll` |
| `list_dns_snapshots` | List local DNS zone backups for a domain |
| `restore_dns_snapshot` | Restore a zone from a local backup snapshot |

> ⚠️ **DNS zone safety.** The underlying Namecheap `setHosts` API is a full-replacement operation — any record not in the call is deleted. **Use `update_dns_record` for single-record adds/updates/deletes.** Never hand-call `set_dns_hosts` to add a record. Every read and every write produces a local snapshot at `~/.config/namecheap-mcp/snapshots/<domain>__<timestamp>-<rand>.json` (up to 50 per domain), so `list_dns_snapshots` + `restore_dns_snapshot` can recover from any accidental damage.

> **Provider mutation approval.** Every tool that can change Namecheap state requires an explicit literal confirmation input (`confirmMutation:true` or, for full-replacement operations, `confirmReplaceAll:true`). Read-only tools do not require confirmation. Mutation success is not inferred from the requested value; the hardened domain lock and privacy tools validate Namecheap's acknowledgement and then read the authoritative state back.

### SSL

| Tool | Description |
|---|---|
| `list_ssl_certs` | List SSL certificates in your account |
| `create_ssl_cert` | Purchase a new SSL certificate |
| `get_ssl_info` | Get details for a specific certificate |
| `activate_ssl` | Activate a purchased certificate with a CSR |
| `reissue_ssl` | Reissue a certificate with a new CSR |

### Transfers

| Tool | Description |
|---|---|
| `transfer_domain` | Initiate an inbound domain transfer (requires EPP code) |
| `get_transfer_status` | Check the status of a pending transfer |
| `list_transfers` | List all transfers, filterable by status |

### Account

| Tool | Description |
|---|---|
| `get_balances` | Account balance and withdrawable amount |
| `get_pricing` | Pricing for domains, SSL, or Whois Guard |
| `auth_status` | Diagnose authentication: whether credentials loaded, whether the API accepted them, and the last error with an actionable hint |

## API Notes

- DNS tools accept a full domain name like `example.com` — SLD/TLD splitting is handled internally
- `namecheap.domains.getList.@_IsLocked` is returned as `listChangeLocked`; it is not treated as authoritative transfer-lock state. `get_domain_info.registrarLocked` comes only from `namecheap.domains.getRegistrarLock`.
- Missing or unrecognized boolean fields are returned as `null`, not silently converted to `false`.
- Auto-renew and privacy status come from the exact domain match in `namecheap.domains.getList`; transfer lock comes from the dedicated registrar-lock endpoint.
- Error `1011102` means your `NAMECHEAP_CLIENT_IP` is not whitelisted in the Namecheap dashboard
- Set `NAMECHEAP_SANDBOX=true` to use `api.sandbox.namecheap.com` for testing

## Development

```bash
git clone https://github.com/ringo380/namecheap-mcp
cd namecheap-mcp
npm install
npm run dev        # tsx watch — no build needed
npm run build      # compile TypeScript
npm run type-check # type-check without emitting
```

After making changes: `npm run build && npm install -g .` to update the global install.

## License

MIT
