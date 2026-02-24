import requests

BASE_URL = "http://localhost:8000"

def test_portfolio_flow():
    # 1. Login as TDM_DEV
    print("1. Logging in as TDM_DEV...")
    resp = requests.post(f"{BASE_URL}/token", data={"username": "dev@trademetric.com", "password": "tdm_dev_password"})
    if resp.status_code != 200:
        print(f"Failed to login TDM_DEV: {resp.text}")
        return
    dev_token = resp.json()["access_token"]
    
    # 2. Create Manager
    print("2. Creating Manager (test_manager@example.com)...")
    headers = {"Authorization": f"Bearer {dev_token}"}
    manager_data = {"email": "test_manager@example.com", "password": "password123", "role": "MANAGER"}
    # Endpoint might be /admin/managers based on previous context
    resp = requests.post(f"{BASE_URL}/admin/managers", json=manager_data, headers=headers)
    if resp.status_code == 200:
        print("Manager created.")
    elif resp.status_code == 400 and "already exists" in resp.text:
        print("Manager already exists (okay).")
    else:
        print(f"Failed to create manager: {resp.status_code} {resp.text}")
        # Proceeding anyway just in case it exists
        
    # 3. Login as Manager
    print("3. Logging in as Manager...")
    resp = requests.post(f"{BASE_URL}/token", data={"username": "test_manager@example.com", "password": "password123"})
    if resp.status_code != 200:
        print(f"Failed to login Manager: {resp.text}")
        return
    manager_token = resp.json()["access_token"]
    
    # 4. Create Portfolio
    print("4. Creating Portfolio...")
    mgr_headers = {"Authorization": f"Bearer {manager_token}"}
    pf_data = {"name": "Test Portfolio Alpha"}
    resp = requests.post(f"{BASE_URL}/portfolios", json=pf_data, headers=mgr_headers)
    
    if resp.status_code == 200:
        print(f"SUCCESS: Portfolio created! {resp.json()}")
    else:
        print(f"FAILURE: Failed to create portfolio. Status: {resp.status_code}")
        print(f"Response: {resp.text}")

if __name__ == "__main__":
    test_portfolio_flow()
