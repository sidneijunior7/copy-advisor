"""
Manual probe for a running hub (local or staging).

  python tools/hub_probe.py listen --host mirror.trademetric.com.br --topic P_7
      ZMQ: prints POS / SNAP / HB (and legacy lines) as a Slave would receive them.
  python tools/hub_probe.py --ws wss://signals.trademetric.com.br listen --key lic_... --login 123456
      WSS: authenticates with a license key, prints WELCOME, the SNAP and the stream of its portfolio.

  python tools/hub_probe.py master --host 127.0.0.1 --key <master_key> --magic 4242
  python tools/hub_probe.py --ws ws://127.0.0.1:8002 master --key mst_... --magic 4242
      Plays a Master: OPEN, MODIFY, PARTIAL, CLOSE on one position, then a V2SYNC.
      The magic must belong to a strategy of that manager, inside a portfolio.
"""
import argparse
import sys
import time

import zmq


def listen(args):
    if args.ws:
        from websockets.sync.client import connect

        if not (args.key and args.login):
            sys.exit("listen over WSS needs --key (the license key) and --login (its MT5 account)")
        with connect(args.ws.rstrip("/") + "/v1/slave", compression=None) as ws:
            ws.send(f"HELLO|slave|v1|{args.key}|{args.login}|probe|0|0")
            print(f"Listening on {args.ws} as license {args.key[:12]}… (Ctrl+C to stop)")
            try:
                for msg in ws:
                    print(time.strftime("%H:%M:%S"), msg)
            except KeyboardInterrupt:
                pass
        return
    if not args.topic:
        sys.exit("listen over ZMQ needs --topic (P_<portfolio id>)")
    ctx = zmq.Context()
    sub = ctx.socket(zmq.SUB)
    sub.connect(f"tcp://{args.host}:{args.sub_port}")
    sub.subscribe(args.topic + " ")
    print(f"Listening to {args.topic} on {args.host}:{args.sub_port} (Ctrl+C to stop)")
    try:
        while True:
            print(time.strftime("%H:%M:%S"), sub.recv_string())
    except KeyboardInterrupt:
        pass
    finally:
        ctx.destroy(linger=0)


def master(args):
    if args.ws:
        from websockets.sync.client import connect

        ws = connect(args.ws.rstrip("/") + "/v1/master", compression=None)
        ws.send(f"HELLO|master|v1|{args.key}|{args.login}|probe")
        welcome = ws.recv(timeout=5)
        print("hub:", welcome)
        if not welcome.startswith("WELCOME|"):
            sys.exit(1)
        send = ws.send
        done = ws.close
    else:
        ctx = zmq.Context()
        push = ctx.socket(zmq.PUSH)
        push.setsockopt(zmq.LINGER, 2000)
        push.connect(f"tcp://{args.host}:{args.push_port}")
        time.sleep(0.5)
        send = lambda body: push.send_string(f"{args.key}|{body}")
        done = lambda: ctx.destroy(linger=2000)

    def step(body):
        send(body)
        print("sent", body)
        time.sleep(args.pause)

    pos = args.pos_id
    for reason, vol, sl in [("OPEN", 1.0, "1.09000"), ("MODIFY", 1.0, "1.09500"), ("PARTIAL", 0.4, "1.09500")]:
        step(f"V2|{args.login}|{reason}|{pos}|0|{args.symbol}|{vol}|1.10000|{sl}|1.12000|{args.magic}")
    step(f"V2SYNC|{args.login}|{pos},0,{args.symbol},0.4,1.10000,1.09500,1.12000,{args.magic}")
    step(f"V2|{args.login}|CLOSE|{pos}|0|{args.symbol}|0|1.10000|1.09500|1.12000|{args.magic}")
    done()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--sub-port", type=int, default=5556)
    p.add_argument("--push-port", type=int, default=5557)
    p.add_argument("--ws", help="WebSocket base URL instead of ZMQ, e.g. wss://signals.trademetric.com.br")
    sub = p.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("listen")
    lp.add_argument("--topic", help="ZMQ: P_<portfolio id>")
    lp.add_argument("--key", help="WSS: license key")
    lp.add_argument("--login", type=int, help="WSS: the license's MT5 account")
    mp = sub.add_parser("master")
    mp.add_argument("--key", required=True)
    mp.add_argument("--magic", type=int, required=True)
    mp.add_argument("--login", type=int, default=999000)
    mp.add_argument("--pos-id", type=int, default=int(time.time()))
    mp.add_argument("--symbol", default="EURUSD")
    mp.add_argument("--pause", type=float, default=2.0)
    args = p.parse_args()
    listen(args) if args.cmd == "listen" else master(args)


if __name__ == "__main__":
    main()
