"""Email: confirming the address, resetting the password, subscription notices (mailer.py)."""
import datetime
import os
import re
import time
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import mailer  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_clients import fresh_limits, signup  # noqa: E402,F401
from test_marketplace import published  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture
def outbox(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_FROM", "Trademetric <no-reply@example.com>")
    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: sent.append({"to": to, "subject": subject, "body": body}))
    # What the user waits on goes out now, and the server took it
    monkeypatch.setattr(mailer, "send_now", lambda to, subject, body: sent.append({"to": to, "subject": subject, "body": body}))
    return sent


def link_token(body: str) -> str:
    return re.search(r"token=([\w-]+)", body).group(1)


def test_confirm_email_before_subscribing(client, outbox):
    _, mgr, _, listing = published(client, title=f"Email {uuid.uuid4().hex[:6]}")
    r, email = signup(client)
    me = {"Authorization": f"Bearer {r.json()['access_token']}"}
    [verify] = outbox
    assert verify["to"] == email and "/verificar-email?token=" in verify["body"]
    assert client.get("/me", headers=me).json()["email_verified"] is False
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=me, json={"mt5_login": 4242})
    assert r.status_code == 403 and "Confirme" in r.json()["detail"]

    token = link_token(verify["body"])
    assert client.post("/email/verify", json={"token": token}).status_code == 200
    assert client.post("/email/verify", json={"token": token}).status_code == 400  # Used up
    assert client.get("/me", headers=me).json()["email_verified"] is True

    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=me, json={"mt5_login": 4242, "note": "Oi"})
    assert r.status_code == 200
    notice = outbox[-1]
    assert notice["subject"].startswith("Novo pedido de assinatura") and "4242" in notice["body"] and "Oi" in notice["body"]
    client.post(f"/subscriptions/{r.json()['id']}/approve", headers=mgr, json={"note": "Bem-vindo"})
    decision = outbox[-1]
    assert decision["to"] == email and decision["subject"].startswith("Assinatura aprovada") and "Bem-vindo" in decision["body"]


def test_reset_password_ends_old_sessions(client, outbox):
    r, email = signup(client)
    old_session = {"Authorization": f"Bearer {r.json()['access_token']}"}
    outbox.clear()
    assert client.post("/password/forgot", json={"email": "ninguem@nada.com"}).status_code == 200
    assert outbox == []  # Same answer, nothing sent
    assert client.post("/password/forgot", json={"email": email.upper()}).status_code == 200
    token = link_token(outbox[-1]["body"])
    assert client.post("/password/reset", json={"token": token, "password": "curta"}).status_code == 422
    time.sleep(1.1)  # Sessions are compared to the second
    assert client.post("/password/reset", json={"token": token, "password": "nova-senha-123"}).status_code == 200
    assert client.post("/password/reset", json={"token": token, "password": "outra-senha-123"}).status_code == 400
    assert client.get("/me", headers=old_session).status_code == 401
    assert client.post("/token", data={"username": email, "password": "s3nha-forte"}).status_code == 401
    r = client.post("/token", data={"username": email, "password": "nova-senha-123"})
    assert r.status_code == 200
    assert client.get("/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).status_code == 200


def test_expired_link_and_a_newer_one_replacing_it(client, outbox):
    r, email = signup(client)
    me = {"Authorization": f"Bearer {r.json()['access_token']}"}
    first = link_token(outbox[-1]["body"])
    assert client.post("/email/resend", headers=me).status_code == 200
    second = link_token(outbox[-1]["body"])
    assert client.post("/email/verify", json={"token": first}).status_code == 400  # Replaced
    db = database.SessionLocal()
    try:
        user = db.query(models.User).filter_by(email=email).one()
        token = mailer.issue_token(db, user, "verify", datetime.datetime.utcnow() - datetime.timedelta(hours=100))
        db.commit()
    finally:
        db.close()
    assert client.post("/email/verify", json={"token": token}).status_code == 400  # Expired
    assert client.post("/email/verify", json={"token": second}).status_code == 400  # Replaced by the expired one


def test_without_smtp(client, monkeypatch):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    assert client.post("/password/forgot", json={"email": "x@y.com"}).status_code == 503
    r, _ = signup(client)
    me = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/me", headers=me).json()["email_enabled"] is False
    assert client.post("/email/resend", headers=me).status_code == 503


def test_delivery_over_smtp(monkeypatch):
    """The worker thread speaks STARTTLS on 587 and SSL on 465, and logs in when there is a user."""
    calls = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None, context=None):
            calls.append(("connect", host, port))

        def starttls(self, context=None):
            calls.append(("starttls",))

        def login(self, user, password):
            calls.append(("login", user))

        def send_message(self, msg):
            calls.append(("send", msg["To"], msg["Subject"]))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_FROM", "no-reply@example.com")
    monkeypatch.setenv("SMTP_USER", "mailer")
    monkeypatch.setenv("SMTP_PASSWORD", "secret")
    mailer.send("a@b.com", "Assunto", "Corpo")
    for _ in range(100):
        if any(c[0] == "send" for c in calls):
            break
        time.sleep(0.02)
    assert calls == [("connect", "smtp.example.com", 587), ("starttls",), ("login", "mailer"), ("send", "a@b.com", "Assunto")]


def test_dev_email_test_shows_what_the_server_answered(client, monkeypatch):
    from test_management import make_manager
    _, dev = make_manager(role="TDM_DEV")
    _, mgr = make_manager()
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None, context=None):
            pass

        def login(self, user, password):
            if password != "right":
                raise mailer.smtplib.SMTPAuthenticationError(535, b"5.7.8 Error: authentication failed")

        def send_message(self, msg):
            sent.append(msg["To"])

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", FakeSMTP)
    for k, v in (("SMTP_HOST", "smtp.example.com"), ("SMTP_PORT", "465"), ("SMTP_FROM", "no-reply@example.com"),
                 ("SMTP_USER", "no-reply@example.com"), ("SMTP_PASSWORD", "wrong")):
        monkeypatch.setenv(k, v)
    assert client.post("/admin/email-test", headers=mgr, json={"to": "a@b.com"}).status_code == 403
    assert client.post("/admin/email-test", headers=dev, json={"to": "sem-arroba"}).status_code == 422
    r = client.post("/admin/email-test", headers=dev, json={"to": "a@b.com"}).json()
    assert r["ok"] is False and r["error"].startswith("SMTPAuthenticationError") and r["port"] == 465 and not sent
    assert "wrong" not in str(r)  # Never the password
    monkeypatch.setenv("SMTP_PASSWORD", "right")
    r = client.post("/admin/email-test", headers=dev, json={"to": "a@b.com"}).json()
    assert r["ok"] is True and r["error"] is None and sent == ["a@b.com"]
    monkeypatch.delenv("SMTP_HOST")
    assert client.post("/admin/email-test", headers=dev, json={"to": "a@b.com"}).json()["ok"] is False


def test_resending_the_link_says_when_the_server_refused_it(client, monkeypatch):
    """The user waits on the link sent again: a refusal shows on screen, without the SMTP server's words."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_FROM", "no-reply@example.com")

    class Refusing:
        def __init__(self, *args, **kwargs):
            raise mailer.smtplib.SMTPAuthenticationError(535, b"5.7.8 Error: authentication failed")

    monkeypatch.setattr(mailer.smtplib, "SMTP", Refusing)
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: None)  # The sign-up's own link, queued
    r, _ = signup(client)
    me = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.post("/email/resend", headers=me)
    assert r.status_code == 502 and "Tente de novo" in r.json()["detail"] and "535" not in r.text
