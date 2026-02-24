import database
import models
import auth

def create_admin():
    db = database.SessionLocal()
    try:
        # Configuration for the first admin
        email = "trademetric@trademetric.com.br"
        password = "Trademetric2026!" # PLEASE CHANGE THIS AFTER FIRST LOGIN
        
        # Check if user already exists
        user = db.query(models.User).filter(models.User.email == email).first()
        if user:
            print(f"User {email} already exists.")
            return

        hashed_password = auth.get_password_hash(password)
        admin_user = models.User(
            email=email,
            password_hash=hashed_password,
            role="TDM_DEV", # Superuser role matching server.py checks
            status="active"
        )
        db.add(admin_user)
        db.commit()
        print(f"=========================================")
        print(f"Admin user created successfully!")
        print(f"Email: {email}")
        print(f"Password: {password}")
        print(f"Role: TDM_DEV")
        print(f"=========================================")
        print(f"IMPORTANT: Use these credentials to log in")
        print(f"and then change your password.")
    except Exception as e:
        print(f"Error creating admin: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    create_admin()
