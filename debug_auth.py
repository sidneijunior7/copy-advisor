from auth import get_password_hash, verify_password

def test_auth():
    pwd = "tdmdev123"
    print(f"Password: {pwd}")
    
    hashed = get_password_hash(pwd)
    print(f"Hash: {hashed}")
    
    is_valid = verify_password(pwd, hashed)
    print(f"Verify Correct Password: {is_valid}")
    
    is_valid_wrong = verify_password("wrong", hashed)
    print(f"Verify Wrong Password: {is_valid_wrong}")

if __name__ == "__main__":
    test_auth()
