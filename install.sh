#!/usr/bin/env bash
# Alpha-Agent-MCP installer.
#
#   curl -fsSL https://join5star.xyz/mcp/install.sh | bash
#
# Source of truth is this GitHub repo — join5star.xyz/mcp/install.sh is a
# live proxy of this exact file, not a separate copy. Downloads the repo
# tarball straight from GitHub, installs deps (which builds it), and prints
# the mcpServers config block ready to paste into any stdio-capable agent
# host (Claude Code, Claude Desktop, OpenClaw, Hermes, Grok Build, ...).

set -euo pipefail

REPO="${ALPHA_AGENT_MCP_REPO:-5StaronSolana/Alpha-Agent-MCP}"
BRANCH="${ALPHA_AGENT_MCP_BRANCH:-main}"
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
INSTALL_DIR="${ALPHA_AGENT_MCP_DIR:-$HOME/.alpha-agent-mcp}"

echo "==> Alpha-Agent-MCP installer"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>=24). Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "error: Node >=24 required, found $(node -v)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required (ships with Node.js)" >&2
  exit 1
fi

echo "==> Fetching source into ${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"

TARBALL="$(mktemp -t alpha-agent-mcp-XXXXXX.tar.gz)"
trap 'rm -f "${TARBALL}"' EXIT
curl -fsSL "${TARBALL_URL}" -o "${TARBALL}"
# GitHub archives extract into a single top-level dir (repo-branch/) — strip it.
tar -xzf "${TARBALL}" -C "${INSTALL_DIR}" --strip-components=1

echo "==> Installing dependencies (builds automatically)"
(cd "${INSTALL_DIR}" && npm install --no-audit --no-fund)

MCP_NAME="${ALPHA_AGENT_MCP_NAME:-polymarket}"
REGISTERED_HOST=""

# Claude Code has a real CLI for this — register it directly instead of
# making the caller hand-edit a config file. Idempotent: a prior install
# under the same name is removed first so re-running never hard-fails.
#
# Gated on $CLAUDECODE=1, not just `command -v claude`: on a machine running
# multiple agent hosts side by side (Hermes, OpenClaw, ... all coexisting
# with a globally-installed Claude Code CLI), `command -v claude` alone is a
# false positive — it detects the binary is *somewhere* in PATH, not that
# Claude Code is the process actually running this script. $CLAUDECODE=1 is
# the real, verifiable signal Claude Code sets for its own subprocesses;
# other hosts' shelled-out `curl | bash` runs won't have it. Registering into
# the wrong host's config silently (while printing a message that reads like
# success) is worse than not auto-registering at all.
if [ "${CLAUDECODE:-}" = "1" ] && command -v claude >/dev/null 2>&1; then
  echo ""
  echo "==> Claude Code session detected — registering the MCP server directly"
  claude mcp remove "${MCP_NAME}" -s user >/dev/null 2>&1 || true
  if claude mcp add "${MCP_NAME}" -s user -- node "${INSTALL_DIR}/dist/index.js"; then
    REGISTERED_HOST="claude-code"
    echo "==> Registered as '${MCP_NAME}' in Claude Code (user scope, read-only until credentials are added)."
  else
    echo "warning: 'claude mcp add' failed — falling back to manual config below." >&2
  fi
elif command -v claude >/dev/null 2>&1; then
  echo ""
  echo "==> Claude Code CLI found on this machine, but this installer isn't running inside a Claude Code"
  echo "    session (no \$CLAUDECODE env var) — skipping auto-registration so it doesn't land in the wrong"
  echo "    host's config. If this install IS meant for Claude Code, register it yourself with:"
  echo "      claude mcp add ${MCP_NAME} -s user -- node ${INSTALL_DIR}/dist/index.js"
fi

echo ""
echo "==> Manual config (any stdio-capable host — Claude Desktop, OpenClaw, Grok Build, Hermes, ...):"
echo ""
cat <<EOF
{
  "mcpServers": {
    "${MCP_NAME}": {
      "command": "node",
      "args": ["${INSTALL_DIR}/dist/index.js"],
      "env": {
        "PRIVATE_KEY": "0x...",
        "WALLET_ADDRESS": "0x..."
      }
    }
  }
}
EOF
echo ""
echo "Claude Desktop's config file lives at:"
echo "  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "  Linux:   ~/.config/Claude/claude_desktop_config.json"
echo "  Windows: %APPDATA%\\Claude\\claude_desktop_config.json"
echo ""
echo "PRIVATE_KEY / WALLET_ADDRESS are optional — omit both to run read-only"
echo "discovery/market-data tools with zero config. Trading stays blocked"
echo "(readOnly guardrail) until set_guardrails is called explicitly, even"
echo "once real credentials are present."
echo ""
echo "Also optional, for API-key authorization (env-only, never hardcoded):"
echo "  POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE"
echo "    — builder API key: builder-attributed CLOB + gasless relayer requests"
echo "  RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS"
echo "    — relayer API key: gasless relayer requests only (builder trio wins)"
echo ""
echo "Test it directly:  node ${INSTALL_DIR}/dist/index.js"
echo ""
echo "---"
echo "If an AI agent is running this installer on a human's behalf:"
echo "1. If the host wasn't auto-registered above (anything but Claude Code),"
echo "   add the MCP config block yourself now — edit the host's config file"
echo "   directly rather than asking the human to do it."
echo "2. Read-only tools (market/price discovery) already work with zero"
echo "   further setup. To unlock CLOB trading, ask your owner for a"
echo "   PRIVATE_KEY (and optionally WALLET_ADDRESS) now — don't wait to be"
echo "   asked. Never invent, reuse, or ask for a key belonging to anyone"
echo "   other than the person you're talking to."
if [ "${REGISTERED_HOST}" = "claude-code" ]; then
  echo "   For this Claude Code registration, wire it in with:"
  echo "     claude mcp remove ${MCP_NAME} -s user && \\"
  echo "     claude mcp add ${MCP_NAME} -s user -e PRIVATE_KEY=0x... -e WALLET_ADDRESS=0x... -- node ${INSTALL_DIR}/dist/index.js"
fi
echo "3. Trading still stays blocked until set_guardrails({ readOnly: false, ... })"
echo "   is called explicitly — walk your owner through sane limits"
echo "   (maxOrderSizeUsd, maxPriceDeviationFromMid) before turning it on."
