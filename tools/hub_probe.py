"""
Manual probe for a running hub (local or staging).

  python tools/hub_probe.py listen --host mirrorserver.trademetric.com.br --topic P_7
      Prints POS / SNAP / HB (and legacy lines) as a Slave would receive them.

  python tools/hub_probe.py master --host 127.0.0.1 --key <master_key> --magic 4242
      Plays a Master: OPEN, MODIFY, PARTIAL, CLOSE on one position, then a V2SYNC.
      The magic must belong to a strategy of that manager, inside a portfolio.
"""
import argparse
import time

import zmq


def listen(args):
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
    ctx = zmq.Context()
    push = ctx.socket(zmq.PUSH)
    push.setsockopt(zmq.LINGER, 2000)
    push.connect(f"tcp://{args.host}:{args.push_port}")
    time.sleep(0.5)
    pos = args.pos_id
    steps = [
        ("OPEN", 1.0, "1.10000", "1.09000", "1.12000"),
        ("MODIFY", 1.0, "1.10000", "1.09500", "1.12000"),
        ("PARTIAL", 0.4, "1.10000", "1.09500", "1.12000"),
    ]
    for reason, vol, price, sl, tp in steps:
        msg = f"{args.key}|V2|{args.login}|{reason}|{pos}|0|{args.symbol}|{vol}|{price}|{sl}|{tp}|{args.magic}"
        push.send_string(msg)
        print("sent", msg)
        time.sleep(args.pause)
    sync = f"{args.key}|V2SYNC|{args.login}|{pos},0,{args.symbol},0.4,1.10000,1.09500,1.12000,{args.magic}"
    push.send_string(sync)
    print("sent", sync)
    time.sleep(args.pause)
    close = f"{args.key}|V2|{args.login}|CLOSE|{pos}|0|{args.symbol}|0|1.10000|1.09500|1.12000|{args.magic}"
    push.send_string(close)
    print("sent", close)
    ctx.destroy(linger=2000)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--sub-port", type=int, default=5556)
    p.add_argument("--push-port", type=int, default=5555)
    sub = p.add_subparsers(dest="cmd", required=True)
    lp = sub.add_parser("listen")
    lp.add_argument("--topic", required=True)
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
