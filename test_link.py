import requests
import json

BASE_URL = "http://localhost:8000"

def test_endpoints():
    print("--- LOGIN ---")
    resp = requests.post(f"{BASE_URL}/token", data={"username": "dev@trademetric.com", "password": "tdmdev123"})
    if resp.status_code != 200:
        print(f"Login failed: {resp.status_code} {resp.text}")
        return
    token = resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Create Manager
    mgr_email = "link_tester@example.com"
    requests.post(f"{BASE_URL}/admin/managers", json={"email": mgr_email, "password": "pass", "role": "MANAGER"}, headers=headers)
    
    # Login as Manager
    resp = requests.post(f"{BASE_URL}/token", data={"username": mgr_email, "password": "pass"})
    mgr_token = resp.json()["access_token"]
    mgr_headers = {"Authorization": f"Bearer {mgr_token}"}

    print("--- SETUP DATA ---")
    # Create Strategy
    s = requests.post(f"{BASE_URL}/strategies", json={"name": "S1", "magic_number": 888}, headers=mgr_headers).json()
    print(f"Strategy Created: ID={s['id']}")

    # Create Portfolio
    p = requests.post(f"{BASE_URL}/portfolios", json={"name": "P1"}, headers=mgr_headers).json()
    print(f"Portfolio Created: ID={p['id']}")

    print("--- TEST 1: LINK STRATEGY (Expect 200) ---")
    link_url = f"{BASE_URL}/portfolios/{p['id']}/add_strategy/{s['id']}"
    print(f"POST {link_url}")
    resp = requests.post(link_url, headers=mgr_headers)
    print(f"Status: {resp.status_code}")
    print(f"Response: {resp.text}")

    print("--- TEST 2: CREATE LICENSE (Expect 200) ---")
    lic_data = {
        "portfolio_id": p['id'],
        "client_mt5_login": 999999,
        "max_lots": 1.5
    }
    resp = requests.post(f"{BASE_URL}/licenses", json=lic_data, headers=mgr_headers)
    print(f"Create License Status: {resp.status_code}")
    print(f"Response: {resp.text}")

    print("--- TEST 3: CHECK LICENSE (Expect 200 active) ---")
    check_payload = {
        "connection_key": p['public_key'],
        "mt5_login": 999999
    }
    resp = requests.post(f"{BASE_URL}/api/license/check", json=check_payload)
    print(f"Check License Status: {resp.status_code}")
    print(f"Response: {resp.text}")

if __name__ == "__main__":
    test_endpoints()
