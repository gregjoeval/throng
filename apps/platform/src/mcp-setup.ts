// What an agent's MCP client is set up with: the server's URL and the bearer header. `llms.txt` shows it
// with `$THRONG_TOKEN`, and throng-web's Tokens page with a just-minted token written in.

/** Where the MCP server is mounted. */
export const MCP_PATH = "/mcp";
/** Where the agents' guide is served. */
export const LLMS_PATH = "/llms.txt";

/** The `claude mcp add` command for the platform at `origin`, authorized with `token`. */
export function claudeMcpAdd(origin: string, token: string): string {
  return `claude mcp add --transport http throng ${origin}${MCP_PATH} --header "Authorization: Bearer ${token}"`;
}

/** The `mcpServers` config other clients take, in the shape Claude Code's `.mcp.json` uses. */
export function mcpServersConfig(origin: string, token: string) {
  return {
    mcpServers: {
      throng: { type: "http", url: `${origin}${MCP_PATH}`, headers: { Authorization: `Bearer ${token}` } },
    },
  };
}
