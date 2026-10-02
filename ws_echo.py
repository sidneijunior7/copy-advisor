"""
WebSocket echo server for the transport prototype (phase 0): validates the MQL5 client
(Include/TDM/WsClient.mqh) against a real MT5 terminal before the hub gets a WebSocket edge.

Runs on its own (service "mirror-ws-echo" in staging), behind the EasyPanel proxy that terminates TLS.
Nothing here touches the database or the hub.

Client -> server (first message within HELLO_TIMEOUT seconds)
    HELLO|probe|v1|<token>|<login>|<ea_version>
Server -> client
    WELCOME|<session>|<heartbeat_s>        (or ERR|<code>|<reason> and close)
    HB|<session>|<n>                       every heartbeat_s seconds
Commands after WELCOME
    ECHO|...            sent back unchanged
    SNAP|<n>            one message "SNAP|<n>|" followed by n bytes of PATTERN
    BURST|<n>           n messages "B|<i>", as fast as possible
    FRAG|<n>|<parts>    one message like SNAP, split into <parts> continuation frames
    CLOSE               server closes cleanly (code 1000)
    DROP                server aborts the TCP connection without a close frame
"""
import asyncio
import logging
import os
import secrets
import signal
import time
from http import HTTPStatus

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

PORT = int(os.getenv("ECHO_PORT", "8002"))
TOKEN = os.getenv("ECHO_TOKEN", "")
HEARTBEAT_S = float(os.getenv("ECHO_HEARTBEAT_S", "5"))
HELLO_TIMEOUT = 5
MAX_SNAP = 1_048_576
MAX_BURST = 10_000
PATTERN = "abcdefghijklmnopqrstuvwxyz"

logger = logging.getLogger("ws_echo")


def pattern(n: int) -> str:
    return (PATTERN * (n // len(PATTERN) + 1))[:n]


def remote(ws: ServerConnection) -> str:
    forwarded = ws.request.headers.get("X-Forwarded-For") if ws.request else None
    return forwarded.split(",")[0].strip() if forwarded else str(ws.remote_address[0])


def health(connection: ServerConnection, request):
    if request.path == "/health":
        return connection.respond(HTTPStatus.OK, "OK\n")
    return None


async def heartbeat(ws: ServerConnection, session: str):
    n = 0
    while True:
        await asyncio.sleep(HEARTBEAT_S)
        n += 1
        await ws.send(f"HB|{session}|{n}")


async def command(ws: ServerConnection, msg: str) -> bool:
    """Handles one message. Returns False when the connection must end."""
    parts = msg.split("|")
    cmd = parts[0]
    if cmd == "ECHO":
        await ws.send(msg)
    elif cmd == "SNAP" and len(parts) >= 2:
        n = min(int(parts[1]), MAX_SNAP)
        await ws.send(f"SNAP|{n}|" + pattern(n))
    elif cmd == "BURST" and len(parts) >= 2:
        for i in range(min(int(parts[1]), MAX_BURST)):
            await ws.send(f"B|{i}")
    elif cmd == "FRAG" and len(parts) >= 3:
        n = min(int(parts[1]), MAX_SNAP)
        k = max(1, int(parts[2]))
        body = f"FRAG|{n}|" + pattern(n)
        step = len(body) // k + 1
        await ws.send([body[i:i + step] for i in range(0, len(body), step)])
    elif cmd == "CLOSE":
        await ws.close(1000, "requested")
        return False
    elif cmd == "DROP":
        ws.transport.abort()
        return False
    else:
        await ws.send(f"ERR|unknown|{cmd[:32]}")
    return True


async def handler(ws: ServerConnection):
    addr = remote(ws)
    started = time.time()
    try:
        hello = await asyncio.wait_for(ws.recv(), HELLO_TIMEOUT)
    except (asyncio.TimeoutError, ConnectionClosed):
        logger.info(f"{addr}: no HELLO")
        return
    parts = str(hello).split("|")
    if len(parts) < 6 or parts[0] != "HELLO" or parts[1] != "probe" or parts[2] != "v1":
        await ws.send("ERR|protocol|expected HELLO|probe|v1|...")
        await ws.close(1008, "protocol")
        return
    if not TOKEN or not secrets.compare_digest(parts[3], TOKEN):
        await ws.send("ERR|auth|invalid token")
        await ws.close(1008, "auth")
        logger.info(f"{addr}: invalid token")
        return

    session = secrets.token_hex(4)
    login, version = parts[4], parts[5]
    logger.info(f"{addr}: session {session} login {login} ea {version}")
    await ws.send(f"WELCOME|{session}|{HEARTBEAT_S:g}")
    hb = asyncio.create_task(heartbeat(ws, session))
    received = 0
    try:
        async for msg in ws:
            received += 1
            if not await command(ws, str(msg)):
                break
    except ConnectionClosed:
        pass
    except ValueError:
        await ws.close(1008, "bad command")
    finally:
        hb.cancel()
        logger.info(f"{addr}: session {session} ended after {time.time() - started:.0f}s, "
                    f"{received} messages, close code {ws.close_code}")


async def main():
    if not TOKEN:
        raise SystemExit("ECHO_TOKEN is required")
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, stop.set_result, None)
        except NotImplementedError:  # Windows
            pass
    # No compression: the MQL5 client does not negotiate extensions
    async with serve(handler, "0.0.0.0", PORT, process_request=health, compression=None,
                     max_size=MAX_SNAP, server_header=None):
        logger.info(f"Echo up on :{PORT}, heartbeat {HEARTBEAT_S:g}s")
        await stop


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    asyncio.run(main())
