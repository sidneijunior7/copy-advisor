"""
Alerts for the copy service (service "mirror-monitor"): checks the API's /health and the hub's WSS edge once a
minute and sends a Telegram message when something breaks, and another when it is back to normal.

Checks
    api           /health does not answer, has no database (503) or the schema is not ready
    hub           the hub block is not healthy (stalled, unreachable) or still warming up
    db            the hub lost the database
    signals       the edge the EAs connect to (signals.../health) does not answer
    masters       fewer Masters connected than MONITOR_MIN_MASTERS, weekdays inside MONITOR_SESSION
    master_quiet  Masters connected but nothing from them for MONITOR_MASTER_QUIET_S (the Master syncs every 10 s)
Writes the hub dropped or gave up on since the last check are reported right away.

A problem is reported after MONITOR_FAILURES failed checks in a row, so a deploy restarting a service does not
page anyone. A check that could not run (no hub data while the API is down) keeps its state: it is reported
back to normal only once it passes.

Running on the same VPS, it cannot report the VPS itself going down. MONITOR_PING_URL takes a dead man's switch
(healthchecks.io, for instance): it is called after every round, and that service alerts when the calls stop.
Standard library only.
"""
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

API_URL = os.getenv("MONITOR_API_URL", "https://mirror.trademetric.com.br/health")
SIGNALS_URL = os.getenv("MONITOR_SIGNALS_URL", "https://signals.trademetric.com.br/health")
INTERVAL_S = float(os.getenv("MONITOR_INTERVAL_S", "60"))
FAILURES = int(os.getenv("MONITOR_FAILURES", "3"))
MIN_MASTERS = int(os.getenv("MONITOR_MIN_MASTERS", "1"))
SESSION = os.getenv("MONITOR_SESSION", "09:00-18:30")  # Brasília time, Monday to Friday
MASTER_QUIET_S = float(os.getenv("MONITOR_MASTER_QUIET_S", "120"))
TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
PING_URL = os.getenv("MONITOR_PING_URL", "")
TIMEOUT_S = 10
MAX_OUTBOX = 50  # Messages kept while Telegram is unreachable
ALIVE_FILE = "/tmp/monitor.alive"  # Touched every round, for the container healthcheck
BRASILIA = timezone(timedelta(hours=-3))  # No daylight saving since 2019

logger = logging.getLogger("monitor")


def fetch(url: str) -> Tuple[int, Optional[dict]]:
    """HTTP status and JSON body (None if not JSON); status 0 when nothing answered."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
            return resp.status, parse(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, parse(e.read())
    except Exception:
        return 0, None


def parse(raw: bytes) -> Optional[dict]:
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def in_session(now: datetime, session: str = SESSION) -> bool:
    start, end = (part.strip() for part in session.split("-"))
    local = now.astimezone(BRASILIA)
    return local.weekday() < 5 and start <= local.strftime("%H:%M") < end


class Monitor:
    def __init__(self):
        self.streak: Dict[str, int] = {}
        self.active: Dict[str, str] = {}  # Problems already reported, with the text sent
        self.lost_writes: Optional[int] = None

    def evaluate(self, api_status: int, api: Optional[dict], signals_status: int,
                 now: datetime) -> Tuple[Dict[str, Optional[str]], List[str]]:
        """Each check that ran, with the problem found (None = passed), and the events to report now."""
        results: Dict[str, Optional[str]] = {
            "signals": None if signals_status == 200 else
            "O endereço dos EAs (signals.trademetric.com.br) não responde: Masters e Slaves não conectam"}
        events: List[str] = []
        if api_status == 0 or api is None:
            results["api"] = "A API (mirror.trademetric.com.br) não responde" + (
                f" (HTTP {api_status})" if api_status else "")
            return results, events
        if api.get("database") == "unavailable":
            results["api"] = "A API está sem banco de dados"
        elif api.get("schema") != "ready":
            results["api"] = f"A API está com o banco em \"{api.get('schema')}\": as rotas de dados respondem 503"
        else:
            results["api"] = None

        hub = api.get("hub") or {}
        if hub.get("status") != "healthy":
            results["hub"] = f"O hub está \"{hub.get('status')}\": as cópias param"
            return results, events
        results["hub"] = "O hub não terminou de carregar" if hub.get("warming") else None
        results["db"] = None if hub.get("db_ok", True) else \
            "O hub perdeu o banco de dados: as cópias seguem, a gravação espera"

        lost = int(hub.get("db_dropped") or 0) + int(hub.get("db_failed") or 0)
        if self.lost_writes is not None and lost > self.lost_writes:
            events.append(f"⚠️ O hub perdeu {lost - self.lost_writes} gravações no banco (sinais ou relatórios)")
        self.lost_writes = lost  # A restarted hub counts from 0 again

        if in_session(now):
            ws = hub.get("ws") or {}
            masters = int(ws.get("masters") or 0)
            results["masters"] = None if masters >= MIN_MASTERS else (
                "Nenhum Master conectado ao hub no pregão" if masters == 0 else
                f"Só {masters} de {MIN_MASTERS} Masters conectados ao hub")
            age = hub.get("last_master_msg_age_seconds")
            if masters > 0:  # With none connected, "masters" covers it
                results["master_quiet"] = None if age is None or age <= MASTER_QUIET_S else \
                    f"O Master está conectado, mas não manda nada há {int(age)} s"
        return results, events

    def step(self, results: Dict[str, Optional[str]]) -> List[str]:
        """Messages to send: a problem on its FAILURES-th failure in a row, and the return of a reported one."""
        messages = []
        for name, problem in results.items():
            if problem:
                self.streak[name] = self.streak.get(name, 0) + 1
                if self.streak[name] == FAILURES:
                    self.active[name] = problem
                    messages.append("🔴 " + problem)
            else:
                self.streak.pop(name, None)
                if name in self.active:
                    messages.append("🟢 Normalizado: " + self.active.pop(name))
        return messages


def send(text: str) -> bool:
    if not (TELEGRAM_TOKEN and TELEGRAM_CHAT_ID):
        logger.warning(f"Telegram not configured: {text}")
        return True
    data = urllib.parse.urlencode({"chat_id": TELEGRAM_CHAT_ID, "text": text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", data=data,
                               timeout=TIMEOUT_S).close()
        return True
    except Exception as e:  # Only the type: the request URL carries the token
        logger.warning(f"Telegram send failed ({type(e).__name__}), will retry: {text}")
        return False


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    monitor = Monitor()
    outbox = [f"Monitor do TDM Mirror ligado: checa a cada {int(INTERVAL_S)} s e avisa depois de {FAILURES} "
              f"falhas seguidas. Pregão: {SESSION}, dias úteis."]
    logger.info(f"Checking {API_URL} and {SIGNALS_URL} every {INTERVAL_S:g} s")
    while True:
        started = time.monotonic()
        api_status, api = fetch(API_URL)
        signals_status, _ = fetch(SIGNALS_URL)
        results, events = monitor.evaluate(api_status, api, signals_status, datetime.now(timezone.utc))
        for problem in filter(None, results.values()):
            logger.info(f"Failing: {problem}")
        outbox += events + monitor.step(results)
        while outbox and send(outbox[0]):
            outbox.pop(0)
        del outbox[:-MAX_OUTBOX]
        if PING_URL:
            try:
                urllib.request.urlopen(PING_URL, timeout=TIMEOUT_S).close()
            except Exception as e:
                logger.warning(f"Ping failed ({type(e).__name__})")
        with open(ALIVE_FILE, "w"):
            pass
        time.sleep(max(1.0, INTERVAL_S - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
