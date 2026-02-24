import database
import models
import auth

def check_users():
    db = database.SessionLocal()
    try:
        print("--- Listing Users in DB ---")
        users = db.query(models.User).all()
        for u in users:
            print(f"ID: {u.id} | Email: {u.email} | Role: {u.role} | Status: {u.status}")
        
        # Test specific user
        target_email = "trademetric@trademetric.com.br"
        user = db.query(models.User).filter(models.User.email == target_email).first()
        if user:
            print(f"\nTarget User Found: {user.email}")
            test_pwd = "Trademetric2026!"
            is_valid = auth.verify_password(test_pwd, user.password_hash)
            print(f"Password Check for '{test_pwd}': {is_valid}")
            
            # Check hardcoded seed user in server.py
            seed_email = "dev@trademetric.com"
            seed_user = db.query(models.User).filter(models.User.email == seed_email).first()
            if seed_user:
                print(f"\nSeed User Found: {seed_user.email}")
                is_seed_valid = auth.verify_password("tdmdev123", seed_user.password_hash)
                print(f"Password Check for 'tdmdev123': {is_seed_valid}")
        else:
            print(f"\nTarget User '{target_email}' NOT found in database.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    check_users()
