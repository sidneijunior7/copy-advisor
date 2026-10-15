"""
Spike signal source: speaks the Master EA protocol (see hub.py) and cycles one position at a time
(open, move SL, close) for the spike strategy, so the Slaves in the pod have something to copy.
Run inside the hub container:
    docker exec tdm-spike-hub python -u spike/fake_master.py --symbol WINZ26 --cycles 3
"""
import argparse
import time

import zmq

parser = argparse.ArgumentParser()
parser.add_argument("--hub", default="tcp://tdm-spike-hub:5557")
parser.add_argument("--key", default="spike-master-key")
parser.add_argument("--login", type=int, default=900001)
parser.add_argument("--magic", type=int, default=777001)
parser.add_argument("--symbol", default="WINZ26")
parser.add_argument("--volume", default="1")
parser.add_argument("--hold", type=float, default=60, help="seconds each position stays open")
parser.add_argument("--gap", type=float, default=60, help="seconds between positions")
parser.add_argument("--cycles", type=int, default=1, help="0 = forever")
args = parser.parse_args()

ctx = zmq.Context()
push = ctx.socket(zmq.PUSH)
push.setsockopt(zmq.LINGER, 2000)
push.connect(args.hub)
time.sleep(0.5)  # Let the connection come up before the first message


def send(body: str):
    push.send_string(f"{args.key}|{body}")
    print(time.strftime("%H:%M:%S"), body, flush=True)


def state(pos_id, reason, volume, sl="0"):
    # price_open 0: a Slave that only learns of the position from a snapshot never opens it late
    return f"V2|{args.login}|{reason}|{pos_id}|0|{args.symbol}|{volume}|0|{sl}|0|{args.magic}"


def hold(seconds, positions):
    """V2SYNC every 10 s, like the Master EA."""
    end = time.time() + seconds
    while time.time() < end:
        body = ";".join(f"{p},0,{args.symbol},{args.volume},0,0,0,{args.magic}" for p in positions)
        push.send_string(f"{args.key}|V2SYNC|{args.login}|{body}")
        time.sleep(min(10, max(0, end - time.time())))


send(f"V2HELLO|{args.login}|demo|SPIKE|fake_master.py")
pos_id = int(time.time())
cycle = 0
while args.cycles == 0 or cycle < args.cycles:
    cycle += 1
    pos_id += 1
    send(state(pos_id, "OPEN", args.volume))
    hold(args.hold, [pos_id])
    send(state(pos_id, "CLOSE", 0))
    hold(args.gap, [])
push.close()
ctx.term()
