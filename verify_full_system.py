
import requests
import zmq
import zmq.asyncio
import asyncio
import json

BASE_URL = "http://127.0.0.1:8000"

async def main():
    print("--- STARTING SYSTEM VERIFICATION ---")

    # 1. Register Manager
    import uuid
    print("\n1. Registering Manager...")
    random_id = str(uuid.uuid4())[:8]
    mgr_email = f"manager_{random_id}@test.com"
    mgr_pass = "123456"
    resp = requests.post(f"{BASE_URL}/register", json={"email": mgr_email, "password": mgr_pass, "role": "MANAGER"})
    if resp.status_code == 200:
        mgr_token = resp.json()["access_token"]
        print("   Manager Registered. Token obtained.")
    else:
        # Maybe already exists, try login
        resp = requests.post(f"{BASE_URL}/token", data={"username": mgr_email, "password": mgr_pass})
        if resp.status_code == 200:
            mgr_token = resp.json()["access_token"]
            print("   Manager Logged In. Token obtained.")
        else:
            print(f"   FAILED to Register/Login Manager: {resp.text}")
            return

    headers = {"Authorization": f"Bearer {mgr_token}"}

    # 2. Create Strategy
    print("\n2. Creating Strategy...")
    resp = requests.post(f"{BASE_URL}/strategies", json={"name": "Alpha One", "magic_number": 11111}, headers=headers)
    if resp.status_code == 200:
        strategy = resp.json()
        strategy_id = strategy["id"]
        secret_key = strategy["secret_key"]
        print(f"   Strategy 'Alpha One' Created. ID: {strategy_id}, Key: {secret_key}")
    else:
        print(f"   FAILED to Create Strategy: {resp.text}")
        return

    # 3. Create Portfolio
    print("\n3. Creating Portfolio...")
    resp = requests.post(f"{BASE_URL}/portfolios", json={"name": "Gold Portfolio"}, headers=headers)
    if resp.status_code == 200:
        portfolio = resp.json()
        portfolio_id = portfolio["id"]
        public_key = portfolio["public_key"]
        print(f"   Portfolio 'Gold Portfolio' Created. ID: {portfolio_id}, Key: {public_key}")
    else:
        print(f"   FAILED to Create Portfolio: {resp.text}")
        return

    # 4. Add Strategy to Portfolio
    print("\n4. Linking Strategy to Portfolio...")
    resp = requests.post(f"{BASE_URL}/portfolios/{portfolio_id}/add_strategy/{strategy_id}", headers=headers)
    if resp.status_code == 200:
        print("   Strategy linked to Portfolio.")
    else:
        print(f"   FAILED to Link: {resp.text}")
        return

    # 5. Whitelist Client (License)
    print("\n5. Whitelisting Client (Login: 5001)...")
    mt5_login = 5001
    resp = requests.post(f"{BASE_URL}/licenses", json={
        "portfolio_id": portfolio_id,
        "client_mt5_login": mt5_login,
        "max_lots": 2.0
    }, headers=headers)
    if resp.status_code == 200:
        print("   License Created for Login 5001.")
    else:
        print(f"   FAILED to Create License: {resp.text}")
        return

    # 6. Simulate Slave Check (HTTP)
    print("\n6. Simulating Slave Authorization Check...")
    check_payload = {"connection_key": public_key, "mt5_login": mt5_login}
    resp = requests.post(f"{BASE_URL}/api/license/check", json=check_payload)
    zmq_sub_topic = ""
    if resp.status_code == 200:
        data = resp.json()
        zmq_sub_topic = data.get("topic")
        print(f"   Authorization SUCCESS. Topic to Subscribe: {zmq_sub_topic}")
    else:
        print(f"   Authorization FAILED: {resp.text}")
        return

    # 7. ZMQ Verification
    print("\n7. Verifying ZMQ Message Flow...")
    ctx = zmq.asyncio.Context()
    
    # SLAVE (SUB)
    sub = ctx.socket(zmq.SUB)
    sub.connect("tcp://localhost:5556")
    sub.subscribe(zmq_sub_topic) # Subscribe to P_{PortfolioID}
    print(f"   Slave Subscribed to {zmq_sub_topic}")
    
    # MASTER (PUSH)
    push = ctx.socket(zmq.PUSH)
    push.connect("tcp://localhost:5555")
    
    await asyncio.sleep(0.5)

    # Send Message
    # Format: SECRET_KEY|ACTION|...
    mock_trade = f"{secret_key}|OPEN|999|0|EURUSD|1.0|1.1|0|0|11111"
    print(f"   Master Pushing: {mock_trade}")
    await push.send_string(mock_trade)

    try:
        msg = await asyncio.wait_for(sub.recv_string(), timeout=2.0)
        print(f"   Slave Received: {msg}")
        # Expected: "P_{id} OPEN|..."
        if zmq_sub_topic in msg and "OPEN" in msg:
            print("   >>> ZMQ VERIFICATION SUCCESS <<<")
        else:
             print("   >>> ZMQ CONTENT MISMATCH <<<")
    except asyncio.TimeoutError:
        print("   >>> ZMQ TIMEOUT (FAILED) <<<")

    sub.close()
    push.close()
    ctx.term()

if __name__ == "__main__":
    asyncio.run(main())
