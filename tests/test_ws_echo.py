"""Echo server for the transport prototype: protocol and test commands, with a real websockets client."""
import asyncio
import urllib.request

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import ws_echo


def run(scenario):
    async def main():
        async with serve(ws_echo.handler, "127.0.0.1", 0, process_request=ws_echo.health, compression=None) as server:
            port = server.sockets[0].getsockname()[1]
            await scenario(f"ws://127.0.0.1:{port}/v1/echo", port)
    asyncio.run(main())


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setattr(ws_echo, "TOKEN", "secret")
    monkeypatch.setattr(ws_echo, "HEARTBEAT_S", 0.2)


async def hello(url):
    ws = await connect(url, compression=None)
    await ws.send("HELLO|probe|v1|secret|123|test")
    assert (await ws.recv()).startswith("WELCOME|")
    return ws


def test_rejects_invalid_token():
    async def scenario(url, _):
        async with connect(url) as ws:
            await ws.send("HELLO|probe|v1|wrong|123|test")
            assert await ws.recv() == "ERR|auth|invalid token"
            with pytest.raises(ConnectionClosed):
                await ws.recv()
            assert ws.close_code == 1008
    run(scenario)


def test_rejects_commands_before_hello():
    async def scenario(url, _):
        async with connect(url) as ws:
            await ws.send("ECHO|1")
            assert (await ws.recv()).startswith("ERR|protocol")
    run(scenario)


def test_echo_snap_frag_burst():
    async def scenario(url, _):
        ws = await hello(url)
        await ws.send("ECHO|1|ação")
        assert await ws.recv() == "ECHO|1|ação"

        await ws.send("SNAP|204800")
        snap = await ws.recv()
        assert snap == "SNAP|204800|" + ws_echo.pattern(204800)

        await ws.send("FRAG|1000|7")
        assert await ws.recv() == "FRAG|1000|" + ws_echo.pattern(1000)

        await ws.send("BURST|500")
        got = []
        while len(got) < 500:
            msg = await ws.recv()
            if not msg.startswith("HB|"):
                got.append(msg)
        assert got == [f"B|{i}" for i in range(500)]
        await ws.close()
    run(scenario)


def test_heartbeat_and_close():
    async def scenario(url, _):
        ws = await hello(url)
        assert (await asyncio.wait_for(ws.recv(), 2)).startswith("HB|")
        await ws.send("CLOSE")
        with pytest.raises(ConnectionClosed):
            while True:
                await ws.recv()
        assert ws.close_code == 1000
    run(scenario)


def test_drop_aborts_without_close_frame():
    async def scenario(url, _):
        ws = await hello(url)
        await ws.send("DROP")
        with pytest.raises(ConnectionClosed):
            while True:
                await ws.recv()
        assert ws.close_code == 1006
    run(scenario)


def test_health():
    async def scenario(_, port):
        body = await asyncio.to_thread(lambda: urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2).read())
        assert body == b"OK\n"
    run(scenario)
