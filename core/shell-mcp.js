/**
 * Shell MCP Server (Model Context Protocol)
 * JSON-RPC 2.0 over stdio. Zero dependencies.
 *
 * Ports the 2-tool MCP gateway pattern from the original TypeScript
 * Agent-Shell (https://github.com/MauricioPerera/Agent-Shell,
 * `src/mcp/server.ts`) onto `core/shell.js`'s `Shell`. Exposes exactly 2
 * tools to the agent, regardless of how many commands are registered in the
 * Shell's `CommandRegistry` — constant ~600-token tool-list cost instead of
 * one schema per command (see `core/mcp.js` for the alternative: one MCP
 * tool per capability, with real per-tool JSON schemas). Discovery happens
 * at runtime via `shell_exec("search ...")` / `shell_exec("describe ...")`
 * instead of `tools/list`.
 *
 * Usage:
 *   import { createShellMCPServer } from './core/shell-mcp.js';
 *   createShellMCPServer(shell);
 */

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// TOOLS — exactly 2, fixed, regardless of registry size
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'shell_help',
    description: 'Returns the Agent Shell interaction protocol. Call this first to learn how to discover and execute commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shell_exec',
    description: 'Execute a command in the Agent Shell. Use "search <query>" to discover commands, "describe <ns:cmd>" to inspect one, then execute with optional flags like --dry-run, --validate, or --confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute (e.g., "search create user", "users:create --name John", "describe users:create")',
        },
      },
      required: ['command'],
    },
  },
];

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

// ---------------------------------------------------------------------------
// REQUEST DISPATCH (pure, testable — no stdio)
// ---------------------------------------------------------------------------

/**
 * Handle a single parsed JSON-RPC request against a `Shell` instance.
 * Returns a JSON-RPC response object, or `null` for notifications (which
 * require no response).
 *
 * Per MCP spec, `tools/list` and `tools/call` are rejected until
 * `initialize` has been sent on this connection — tracked via `state`
 * (defaults to a fresh, single-call state when omitted; pass the same
 * object across calls to exercise the real gated handshake, the way
 * `createShellMCPServer` does for one stdio connection's lifetime).
 *
 * @param {{ id?: any, method: string, params?: object }} request
 * @param {import('./shell.js').Shell} shell
 * @param {{ initialized: boolean }} [state]
 * @returns {Promise<object|null>}
 */
export async function handleShellMCPRequest(request, shell, state = { initialized: false }) {
  const { id, method, params } = request || {};

  if (id === undefined) return null; // notifications get no response

  switch (method) {
    case 'initialize': {
      state.initialized = true;
      return rpcOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'automators-kit-shell', version: '1.0.0' },
      });
    }

    case 'notifications/initialized':
      return null;

    case 'ping':
      return rpcOk(id, {});

    case 'tools/list':
    case 'tools/call': {
      if (!state.initialized) {
        return rpcError(id, -32600, 'Server not initialized. Send "initialize" first.');
      }
      return method === 'tools/list'
        ? rpcOk(id, { tools: TOOLS })
        : handleToolsCall(id, params, shell);
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleToolsCall(id, params, shell) {
  const name = params?.name;
  if (!name) return rpcError(id, -32602, 'Missing tool name');

  try {
    if (name === 'shell_help') {
      return rpcOk(id, toolResult(shell.help()));
    }
    if (name === 'shell_exec') {
      const command = params?.arguments?.command;
      if (typeof command !== 'string') {
        return rpcOk(id, toolResult('Error: "command" argument is required and must be a string', true));
      }
      const response = await shell.exec(command);
      return rpcOk(id, toolResult(JSON.stringify(response, null, 2), response.code !== 0));
    }
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  } catch (err) {
    // Defensive: Shell.exec() already catches handler errors internally and
    // never throws. This only guards against something escaping that
    // contract; the real message stays server-side.
    console.error(`[shell-mcp] tool '${name}' failed: ${err?.message ?? err}`);
    return rpcOk(id, toolResult('Internal error processing tool call', true));
  }
}

// ---------------------------------------------------------------------------
// MCP SERVER — stdio wiring
// ---------------------------------------------------------------------------

/**
 * Create and start the shell's 2-tool MCP server over stdio.
 * @param {import('./shell.js').Shell} shell
 * @returns {{ tools: object[] }}
 */
export function createShellMCPServer(shell) {
  const state = { initialized: false };
  const rl = createInterface({ input: process.stdin, terminal: false });

  function send(msg) {
    process.stdout.write(msg + '\n');
  }

  rl.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }

    try {
      const response = await handleShellMCPRequest(request, shell, state);
      if (response) send(JSON.stringify(response));
    } catch (err) {
      console.error(`[shell-mcp] dispatch error: ${err?.message ?? err}`);
      send(JSON.stringify(rpcOk(request?.id ?? null, toolResult('Internal error processing tool call', true))));
    }
  });

  rl.on('close', () => process.exit(0));

  console.error('Automators Kit Shell MCP server running on stdio (2 tools: shell_help, shell_exec)');

  return { tools: TOOLS };
}
