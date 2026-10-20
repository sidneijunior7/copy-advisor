"""
Email: one-time links (confirm the address, reset the password) and notices about marketplace subscriptions,
through any SMTP server (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM). Messages go out from a
background thread, so a slow server never holds a request.

Without SMTP_HOST and SMTP_FROM nothing is sent: the log says what would have gone out (never the link), password
reset is not available, and an unconfirmed address may still subscribe.

Links are single-use: only the SHA-256 of a token is stored, a new one replaces the earlier ones of the same kind,
and they expire (TOKEN_HOURS).
"""
import datetime
import logging
import os
import queue
import secrets
import smtplib
import ssl
import threading
from email.message import EmailMessage
from typing import Optional

from sqlalchemy.orm import Session

import keys
import models

logger = logging.getLogger(__name__)

TOKEN_HOURS = {"verify": 72, "reset": 1}
_outbox: "queue.Queue[EmailMessage]" = queue.Queue(maxsize=1000)
_worker: Optional[threading.Thread] = None
_worker_lock = threading.Lock()


def enabled() -> bool:
    return bool(os.getenv("SMTP_HOST")) and bool(os.getenv("SMTP_FROM"))


def public_url() -> str:
    return os.getenv("PUBLIC_URL", "https://mirror.trademetric.com.br").rstrip("/")


def _message(to: str, subject: str, body: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = os.environ["SMTP_FROM"], to, subject
    msg.set_content(body)
    return msg


def send(to: str, subject: str, body: str):
    """Queues a plain-text message; drops it, with a log line, when email is off or the queue is full."""
    if not enabled():
        logger.info(f"Email off (SMTP_HOST/SMTP_FROM unset): not sending '{subject}' to {to}")
        return
    msg = _message(to, subject, body)
    try:
        _outbox.put_nowait(msg)
    except queue.Full:
        logger.error(f"Email queue full: dropped '{subject}' to {to}")
        return
    logger.info(f"Email queued: '{subject}' to {to}")
    _ensure_worker()


def _ensure_worker():
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="mailer", daemon=True)
            _worker.start()


def _run():
    while True:
        msg = _outbox.get()
        try:
            _deliver(msg)
            logger.info(f"Email sent: '{msg['Subject']}' to {msg['To']}")
        except Exception as e:  # The server's message, never the credentials
            logger.error(f"Email to {msg['To']} failed ({type(e).__name__}: {str(e)[:200]})")


def _deliver(msg: EmailMessage):
    host, port = os.environ["SMTP_HOST"], int(os.getenv("SMTP_PORT", "587"))
    user, password = os.getenv("SMTP_USER", ""), os.getenv("SMTP_PASSWORD", "")
    context = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=20, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
        server.starttls(context=context)
    with server:
        if user:
            server.login(user, password)
        server.send_message(msg)


def send_now(to: str, subject: str, body: str) -> Optional[str]:
    """Sends in the caller's thread, for a message the user is waiting on: None when the server took it, else why
    not. The SMTP server's own words go to the log only."""
    if not enabled():
        return "O envio de emails não está configurado"
    try:
        _deliver(_message(to, subject, body))
    except Exception as e:  # The server's message, never the credentials
        logger.error(f"Email to {to} failed ({type(e).__name__}: {str(e)[:200]})")
        return "O servidor de email recusou o envio"
    logger.info(f"Email sent: '{subject}' to {to}")
    return None


def test(to: str) -> dict:
    """Sends one message now, outside the queue, for the dev dashboard: what the SMTP server answered, and how the
    queue is (a message stuck in it with no worker alive means nothing goes out)."""
    with _worker_lock:
        worker_alive = _worker is not None and _worker.is_alive()
    out = {"host": os.getenv("SMTP_HOST") or None, "port": int(os.getenv("SMTP_PORT", "587")),
           "sender": os.getenv("SMTP_FROM") or None, "queued": _outbox.qsize(), "worker_alive": worker_alive}
    if not enabled():
        return {**out, "ok": False, "error": "SMTP_HOST ou SMTP_FROM não configurados"}
    msg = _message(to, "Teste de envio do Trademetric Mirror",
                   f"Este é um teste do envio de emails do Trademetric Mirror ({public_url()}). Se chegou, o envio funciona.\n")
    try:
        _deliver(msg)
    except Exception as e:  # The server's message, never the credentials
        logger.error(f"Test email to {to} failed ({type(e).__name__}: {str(e)[:200]})")
        return {**out, "ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
    logger.info(f"Test email sent to {to}")
    return {**out, "ok": True, "error": None}


# --- One-time links ---

def issue_token(db: Session, user: models.User, kind: str, now: datetime.datetime) -> str:
    """A new link token; the earlier unused ones of this kind stop working. The caller commits."""
    db.query(models.UserToken).filter(models.UserToken.user_id == user.id, models.UserToken.kind == kind,
                                      models.UserToken.used_at.is_(None)).update({models.UserToken.used_at: now})
    token = secrets.token_urlsafe(32)
    db.add(models.UserToken(user_id=user.id, kind=kind, token_hash=keys.key_hash(token), created_at=now,
                            expires_at=now + datetime.timedelta(hours=TOKEN_HOURS[kind])))
    return token


def consume_token(db: Session, kind: str, token: str, now: datetime.datetime) -> Optional[models.User]:
    """The user a valid token belongs to, marking it used; None if unknown, used or expired. The caller commits."""
    row = db.query(models.UserToken).filter(models.UserToken.token_hash == keys.key_hash(token or ""),
                                            models.UserToken.kind == kind).first()
    if row is None or row.used_at is not None or row.expires_at <= now:
        return None
    row.used_at = now
    return db.get(models.User, row.user_id)


# --- Messages (plain text, Portuguese: what the users read) ---

def send_verification(user: models.User, token: str, wait: bool = False) -> Optional[str]:
    """Queued at sign-up; with wait (the user asked for the link again) sent now, returning why it failed."""
    subject = "Confirme seu email no Trademetric Mirror"
    body = (f"Olá{', ' + user.name if user.name else ''}.\n\n"
            f"Para confirmar este email, abra o link abaixo (vale por {TOKEN_HOURS['verify']} horas):\n\n"
            f"{public_url()}/verificar-email?token={token}\n\n"
            "Se não foi você que criou a conta, ignore esta mensagem.\n")
    if wait:
        return send_now(user.email, subject, body)
    send(user.email, subject, body)
    return None


def send_reset(user: models.User, token: str):
    send(user.email, "Redefinição de senha do Trademetric Mirror",
         "Recebemos um pedido para redefinir a senha desta conta. Para criar uma nova, abra o link abaixo "
         f"(vale por {TOKEN_HOURS['reset']} hora, uma vez só):\n\n"
         f"{public_url()}/redefinir-senha?token={token}\n\n"
         "Se não foi você, ignore esta mensagem: a senha atual continua valendo.\n")


def account_of(sub: models.Subscription) -> str:
    return f" para a conta MT5 {sub.mt5_login}" if sub.mt5_login else ""


def send_new_subscription(manager: models.User, sub: models.Subscription):
    client = sub.client
    send(manager.email, f"Novo pedido de assinatura: {sub.listing.title}",
         f"{client.name or client.email} ({client.email}) pediu {'a renovação de' if sub.kind == 'renewal' else ''} "
         f"{sub.listing.title}{account_of(sub)}.\n"
         + (f"\nMensagem do cliente: {sub.note}\n" if sub.note else "")
         + f"\nAprove ou recuse em {public_url()}/manager/subscriptions\n")


def send_decision(sub: models.Subscription):
    client = sub.client
    if sub.status == "approved":
        lic = sub.license
        until = lic.expires_at.strftime("%d/%m/%Y") if lic and lic.expires_at else "sem data de validade"
        body = (f"Sua assinatura de {sub.listing.title}{account_of(sub)} foi aprovada, "
                f"válida até {until}.\n\nVeja como começar a copiar em {public_url()}/client/licenses/{sub.license_id}\n")
        subject = f"Assinatura aprovada: {sub.listing.title}"
    else:
        body = (f"Seu pedido de {sub.listing.title}{account_of(sub)} foi recusado.\n"
                + (f"\nMotivo: {sub.decision_note}\n" if sub.decision_note else "")
                + f"\nDúvidas? Responda a quem vende o portfólio pelo marketplace: {public_url()}/marketplace/{sub.listing.slug}\n")
        subject = f"Pedido recusado: {sub.listing.title}"
    if sub.decision_note and sub.status == "approved":
        body += f"\nMensagem do gestor: {sub.decision_note}\n"
    send(client.email, subject, body)
