"""
Manual probe for a running hub (local or production), over the same WebSocket the EAs use.

  python tools/hub_probe.py listen --key lic_... --login 123456
      Authenticates with a license key and prints WELCOME, the SNAP and the stream of its portfolio.

  python tools/hub_probe.py --ws ws://127.0.0.1:8002 master --key mst_... --magic 4242
      Plays a Master: OPEN, MODIFY, PARTIAL, CLOSE on one position, then a V2SYNC.
      The magic must belong to a strategy of that manager, inside a portfolio.
"""
import argparse
import time

from websockets.sync.client import connect


def listen(args):
    with connect(args.ws.rstrip("/") + "/v1/slave", compression=None) as ws:
        ws.send(f"HELLO|slave|v1|{args.key}|{args.login}|probe|0|0")
        print(f"Listening on {args.ws} as license {args.key[:12]}… (Ctrl+C to stop)")
        try:
            for msg in ws:
                print(time.strftime("%H:%M:%S"), msg)
        except KeyboardInterrupt:
            pass


def master(args):
    with connect(args.ws.rstrip("/") + "/v1/master", compression=None) as ws:
        ws.send(f"HELLO|master|v1|{args.key}|{args.login}|probe")
        welcome = ws.recv(timeout=5)
        print("hub:", welcome)
        if not welcome.startswith("WELCOME|"):
            raise SystemExit(1)

        def step(body):
            ws.send(body)
            print("sent", body)
            time.sleep(args.pause)

        pos = args.pos_id
        for reason, vol, sl in [("OPEN", 1.0, "1.09000"), ("MODIFY", 1.0, "1.09500"), ("PARTIAL", 0.4, "1.09500")]:
            step(f"V2|{args.login}|{reason}|{pos}|0|{args.symbol}|{vol}|1.10000|{sl}|1.12000|{args.magic}")
        step(f"V2SYNC|{args.login}|{pos},0,{args.symbol},0.4,1.10000,1.09500,1.12000,{args.magic}")
        step(f"V2|{args.login}|CLOSE|{pos}|0|{args.symbol}|0|1.10000|1.09500|1.12000|{args.magic}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ws", default="wss://signals.trademetric.com.br", help="hub WebSocket base URL")
    sub = p.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("listen")
    lp.add_argument("--key", required=True, help="license key (lic_...)")
    lp.add_argument("--login", type=int, required=True, help="the license's MT5 account")
    mp = sub.add_parser("master")
    mp.add_argument("--key", required=True, help="master key (mst_...)")
    mp.add_argument("--magic", type=int, required=True)
    mp.add_argument("--login", type=int, default=999000)
    mp.add_argument("--pos-id", type=int, default=int(time.time()))
    mp.add_argument("--symbol", default="EURUSD")
    mp.add_argument("--pause", type=float, default=2.0)
    args = p.parse_args()
    listen(args) if args.cmd == "listen" else master(args)


if __name__ == "__main__":
    main()
