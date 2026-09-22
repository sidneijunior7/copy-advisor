"""
Create a TDM_DEV account, or set a new password on an existing account.

    python create_admin.py <email>

The password is read from the terminal (or from ADMIN_PASSWORD, for non-interactive consoles
such as EasyPanel's) and is never printed.
"""
import getpass
import os
import sys

import database
import models
import auth


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    email = sys.argv[1].strip().lower()

    password = os.getenv("ADMIN_PASSWORD")
    if not password:
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Repeat: "):
            sys.exit("Passwords do not match")
    error = auth.validate_password(password)
    if error:
        sys.exit(error)

    db = database.SessionLocal()
    try:
        user = db.query(models.User).filter(models.User.email == email).first()
        if user:
            user.password_hash = auth.get_password_hash(password)
            print(f"Password updated for {email} ({user.role})")
        else:
            db.add(models.User(email=email, password_hash=auth.get_password_hash(password),
                               role="TDM_DEV", status="active"))
            print(f"TDM_DEV account created: {email}")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
