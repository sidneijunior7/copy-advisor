import os

import requests

url = "http://localhost:8000/token"
data = {
    "username": os.environ["ADMIN_EMAIL"],
    "password": os.environ["ADMIN_PASSWORD"]
}

print("Testing /token with form data...")
response = requests.post(url, data=data)
print(f"Status: {response.status_code}")
print(f"Body: {response.text}")

print("\nTesting /token with JSON data (should fail)...")
response = requests.post(url, json=data)
print(f"Status: {response.status_code}")
print(f"Body: {response.text}")
