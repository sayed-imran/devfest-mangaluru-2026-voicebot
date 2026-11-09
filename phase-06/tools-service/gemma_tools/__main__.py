"""`python -m gemma_tools` starts the tools service (same command on every OS)."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m gemma_tools", description="Gemma tools service")
    parser.add_argument("--host", help="interface to listen on (default 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port to listen on (default 8765)")
    parser.add_argument("--dry-run", action="store_true", help="log actions instead of opening anything")
    parser.add_argument("--check", action="store_true", help="print what this computer can open, then exit")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")

    if args.host:
        os.environ["TOOLS_HOST"] = args.host
    if args.port:
        os.environ["TOOLS_PORT"] = str(args.port)
    if args.dry_run:
        os.environ["TOOLS_DRY_RUN"] = "1"

    from .config import get_settings
    from .desktop.launcher import desktop_status

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for noisy in ("httpx", "httpcore", "httpx2", "mcp"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.check:
        print(json.dumps(desktop_status(), indent=2))
        return

    settings = get_settings()
    if not settings.is_loopback and not settings.api_key:
        sys.exit(
            f"Refusing to listen on {settings.host} without TOOLS_API_KEY: anyone on the network could "
            "open things on this computer. Set TOOLS_API_KEY here and in the voicebot's .env.local, "
            "or keep TOOLS_HOST=127.0.0.1."
        )

    import uvicorn

    uvicorn.run("gemma_tools.server:app", host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
