# Integrating Alpha-Agent-MCP

This server speaks plain MCP over stdio (`tools/list` + `tools/call`,
JSON-RPC). Any MCP-compatible host — Claude Code, Claude Desktop, OpenClaw,
Hermes, or a custom agent loop — connects the same way: spawn
`node dist/mcp.js` as a subprocess and talk JSON-RPC over its stdin/stdout.

There is nothing framework-specific to wire up. `mcp-client-config.json` in
this folder is the standard `mcpServers` block used by MCP hosts that read
that shape directly (Claude Code / Claude Desktop do). For a host with a
different config format (OpenClaw, Hermes, or anything else), translate the
same three pieces into its native schema:

- **command + args**: `node dist/mcp.js` (build first with `npm run build`,
  or use `npm run mcp` which does not rebuild for you — run `npm run build`
  at least once beforehand).
- **cwd**: the absolute path to this repo, so `dist/mcp.js` resolves and the
  server can find `.env` via its working directory.
- **env**: only `PRIVATE_KEY` + `WALLET_ADDRESS` are needed for authenticated
  trading; every other var in the block is optional (see `src/config/env.ts`
  for the full, current list — that file is the source of truth, not this
  doc). Omit auth vars entirely to run read-only/discovery tools with zero
  config.

**This package is not published to the npm registry** — a bare
`npx alpha-agent-mcp` won't work (npm would try to resolve that as a
registry package name and fail). It *is* runnable via `npx` today using a
git specifier, which is what the main README's one-command setup uses and
what this repo's own test suite exercises end-to-end:

```bash
npx -y -p github:5StaronSolana/Alpha-Agent-MCP alpha-agent-mcp
```

`npx` clones the repo, runs `npm install` (which builds via the `prepare`
script), and starts `dist/mcp.js` over stdio — no local clone required. The
local-clone + `command`/`args`/`cwd` config above is still the right choice
when you want to read or modify the code, or pin to a specific commit
instead of always pulling `main`. Any Claude Code, Grok-built, or other
MCP-spec-compliant agent works identically either way — the protocol layer
(handshake, `tools/list`, `tools/call`) is host-agnostic by construction;
nothing in this server is Claude-specific.

## First run

```bash
npm install
npm run build
npm test                 # smoke test: handshake + tools/list + one live call
npm run mcp              # start the server for real, stdio, blocks until killed
```

`npm test` needs outbound network access to `clob.polymarket.com` /
`data-api.polymarket.com` (or a public Gamma/Data mirror) to fully validate
the live call; without it, it still confirms the MCP protocol layer itself
(handshake, tool schema shape, tool count) and reports the network step as
skipped rather than failing the whole run.

## Verifying builder attribution

Independent of MCP wiring: `npm run check-builder-attribution` confirms
whether Polymarket has anything recorded against the builder code hardcoded
in `src/config/builder-code.ts`. See that script for details — it needs the
same network access as the smoke test's live call.

See `agent-cookbook.md` for example prompts using real, current tool names.
