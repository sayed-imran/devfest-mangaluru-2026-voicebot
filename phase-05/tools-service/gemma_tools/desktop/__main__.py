"""Run the desktop tools as a standalone stdio MCP server."""

from .server import server

if __name__ == "__main__":
    server.run("stdio")
