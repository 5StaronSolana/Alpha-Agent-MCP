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
  echo "error: node is required (>=22). Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "error: Node >=22 required, found $(node -v)" >&2
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

echo ""
echo "==> Installed. Add this to your agent host's MCP config:"
echo ""
cat <<EOF
{
  "mcpServers": {
    "polymarket": {
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
echo "PRIVATE_KEY / WALLET_ADDRESS are optional — omit both to run read-only"
echo "discovery/market-data tools with zero config. Trading stays blocked"
echo "(readOnly guardrail) until you explicitly call set_guardrails."
echo ""
echo "Test it directly:  node ${INSTALL_DIR}/dist/index.js"
