"""
Hosting pod agent (Dockerfile.pod): runs the hosted terminals assigned to this pod, one MetaTrader 5 per
terminal in /portable mode, all in one Wine prefix and one Xvfb (see tools/spike for how this was measured).

Every SYNC_SECONDS it calls the API's POST /pods/sync with the state of each terminal and gets back the list it
should run (hosting.py). A terminal is started with the broker login from start.ini and the Slave attached by
its [StartUp] section; a new configuration version restarts it. A disabled terminal is stopped and keeps its
folder, where the Slave keeps its copy mapping; a terminal left out of the list is stopped and its folder
deleted. A terminal that dies is started again, waiting longer each time; a refused login is not retried with
the same password, since brokers lock accounts after a few. A removed terminal's folder is kept for
RETIRED_DAYS under slots/.removed before it goes.

State comes from the terminal's own logs: the journal says whether the broker accepted the login, the
Experts log whether the Slave got its license from the hub.

Assets in POD_DIR (/opt/pod):
    brokers/brokers.json   broker server -> {"file": servers.dat of that broker, "symbol": a symbol it lists}
    webrequest_url.txt     the "WebRequestUrl=" line of a common.ini saved by a terminal of this image: the
                           allowed URL list is stored encrypted there and cannot come from start.ini
    Trademetric Copy Trader Slave.ex5
Python 3.10 (the base image's), standard library only. Passwords and keys are never logged.
"""
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional

VERSION = "1"
API_URL = os.getenv("API_URL", "https://mirror.trademetric.com.br").rstrip("/")
POD_KEY = os.getenv("POD_KEY", "")
CAPACITY = int(os.getenv("CAPACITY", "10"))
WS_HOST = os.getenv("WS_HOST", "signals.trademetric.com.br")
WS_PORT = int(os.getenv("WS_PORT", "443"))
WS_TLS = os.getenv("WS_TLS", "1") == "1"
STAGGER_SECONDS = float(os.getenv("STAGGER_SECONDS", "20"))  # A starting terminal pegs a CPU
LOGIN_TIMEOUT_S = float(os.getenv("LOGIN_TIMEOUT_S", "180"))
POD_DIR = os.getenv("POD_DIR", "/opt/pod")
BASE = "/root/.wine64/drive_c/MT5"  # The image's warmed MT5
SLOTS_DIR = "/root/.wine64/drive_c/slots"
SLAVE_EX5 = "Trademetric Copy Trader Slave.ex5"
BACKOFF_S = (30, 60, 120, 300, 600)
TIMEOUT_S = 15
SYNC_SECONDS = 15
RETIRED_DAYS = 7  # A removed terminal's folder is kept this long, mapping included, in case it was a mistake
NO_BROKER = "Sem conexão com a corretora: confira o servidor"
CONNECTED = "Conectado à corretora; aguardando o hub"

logger = logging.getLogger("pod")

# MT5 journal (logs/): the broker's answer to the login. "Invalid account" is a wrong login or password; other
# refusals ("Service is not available") may pass, and MT5 retries by itself, up to AUTH_RETRIES times
AUTHORIZED = re.compile(r"': authorized on ")
AUTH_FAILED = re.compile(r"authorization on .+ failed \((.+)\)")
AUTH_RETRIES = 3
# Experts log (MQL5/Logs/): what the Slave says about the hub
EXPERTS = [
    (re.compile(r"Licença do portfólio \d+"), "running", None),
    (re.compile(r"recusou a chave da licença|não é desta conta|chave desta licença foi trocada"), "key_refused",
     "O hub recusou a chave da licença"),
    (re.compile(r"Outro terminal conectou com esta licença"), "error", "Outro terminal assumiu esta licença"),
    (re.compile(r"conexão bloqueada pelo terminal"), "error", "O endereço do hub não está na lista do WebRequest do pod"),
    (re.compile(r"Licença revogada ou expirada"), "running", "Licença revogada ou expirada: só gere as posições abertas"),
    (re.compile(r"Licença ativa: copiando"), "running", None),
]


def utf16(text: str) -> bytes:
    """MT5 reads .set files and writes its .ini and logs as UTF-16LE with a BOM and CRLF."""
    return b"\xff\xfe" + text.replace("\n", "\r\n").encode("utf-16-le")


def read_utf16(path: str) -> str:
    with open(path, "rb") as f:
        return f.read().decode("utf-16", errors="replace")


def newest_log(folder: str) -> Optional[str]:
    try:
        logs = [os.path.join(folder, n) for n in os.listdir(folder) if n.lower().endswith(".log")]
    except OSError:
        return None
    return max(logs, key=os.path.getmtime) if logs else None


class Slot:
    """One hosted terminal in this pod: its folder, its process and what its logs said."""

    def __init__(self, tid: int):
        self.id = tid
        self.dir = os.path.join(SLOTS_DIR, f"t{tid}")
        self.version = 0  # Configuration running (0 = none yet)
        self.config: dict = {}
        self.status, self.detail = "starting", None
        self.can_start = False  # Enabled, and nothing (no servers.dat, a refused login) keeps it from running
        self.proc: Optional[subprocess.Popen] = None
        self.started_at = 0.0  # 0 = not started by this agent, or stopped on purpose
        self.failures = 0
        self.auth_failures = 0
        self.retry_at = 0.0
        self.offsets: Dict[str, int] = {}

    def pid(self) -> Optional[int]:
        """The Wine process running this slot's terminal64.exe, not the start.exe that launched it."""
        image = f"c:\\slots\\t{self.id}\\terminal64.exe".encode()
        for entry in os.listdir("/proc"):
            if entry.isdigit():
                try:
                    with open(f"/proc/{entry}/cmdline", "rb") as f:
                        if f.read().split(b"\0", 1)[0].lower() == image:
                            return int(entry)
                except OSError:
                    continue
        return None

    def running(self) -> bool:
        if self.proc is not None and self.proc.poll() is not None:
            self.proc = None  # Reaped, so it does not linger as a zombie
        return self.pid() is not None

    def stop(self):
        self.started_at = 0.0
        pid = self.pid()
        if pid is None:
            return
        # The Slave saves its mapping every time it changes: a hard stop loses nothing it needs
        os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            time.sleep(0.5)
            if self.pid() is None:
                return
        pid = self.pid()
        if pid is not None:
            os.kill(pid, signal.SIGKILL)
        self.running()

    def prepare(self, config: dict, brokers: dict) -> Optional[str]:
        """Writes the folder for this configuration; an error message if it cannot run here."""
        broker = brokers.get(config["server"])
        if broker is None:
            return f"Este pod não tem o servers.dat do servidor {config['server']}"
        d = self.dir
        if not os.path.isfile(os.path.join(d, "terminal64.exe")):
            os.makedirs(d, exist_ok=True)
            for name in ("terminal64.exe", "MetaEditor64.exe", "metatester64.exe", "Terminal.ico"):
                shutil.copy2(os.path.join(BASE, name), d)
            for name in ("Sounds", "MQL5", "config"):
                shutil.copytree(os.path.join(BASE, name), os.path.join(d, name), symlinks=True, dirs_exist_ok=True)
            # A new folder recompiles every source under MQL5 on its first start: keep only what runs. MetaEditor
            # and the tester stay, or LiveUpdate downloads them (~57 MB) for every terminal.
            for name in ("Experts", "Indicators", "Scripts", "Services", "Include", "Images", "Profiles/Charts"):
                shutil.rmtree(os.path.join(d, "MQL5", name), ignore_errors=True)
            shutil.rmtree(os.path.join(d, "logs"), ignore_errors=True)
            if os.path.exists(os.path.join(d, "config", "accounts.dat")):
                os.remove(os.path.join(d, "config", "accounts.dat"))
            logger.info(f"t{self.id}: folder created")
        # Without the broker's servers the terminal silently never connects
        shutil.copy2(os.path.join(POD_DIR, "brokers", broker["file"]), os.path.join(d, "config", "servers.dat"))
        set_webrequest_list(os.path.join(d, "config", "common.ini"))
        # The base image's Default.tpl carries another EA, which would replace ours on the startup chart
        tpl = os.path.join(d, "MQL5", "Profiles", "Templates", "Default.tpl")
        if os.path.exists(tpl):
            os.remove(tpl)
        for sub in ("Experts/TDM", "Presets"):
            os.makedirs(os.path.join(d, "MQL5", sub), exist_ok=True)
        shutil.copy2(os.path.join(POD_DIR, SLAVE_EX5), os.path.join(d, "MQL5", "Experts", "TDM", SLAVE_EX5))

        inputs = {"inp_connection_key": config["license_key"], "inp_ws_host": WS_HOST,
                  "inp_ws_port": str(WS_PORT), "inp_ws_tls": "true" if WS_TLS else "false", **config["inputs"]}
        with open(os.path.join(d, "MQL5", "Presets", "hosted.set"), "wb") as f:
            f.write(utf16("".join(f"{k}={v}\n" for k, v in inputs.items())))
        # WebRequest=1 ticks "Allow WebRequest for listed URL"; the list itself comes from common.ini
        start = (f"[Common]\nLogin={config['login']}\nPassword={config['password']}\nServer={config['server']}\n"
                 "NewsEnable=0\n[Charts]\nMaxBars=1000\nPreloadCharts=0\n"
                 "[Experts]\nAllowLiveTrading=1\nAllowDllImport=0\nEnabled=1\nAccount=0\nProfile=0\nWebRequest=1\n"
                 f"[StartUp]\nExpert=TDM\\{SLAVE_EX5[:-4]}\nExpertParameters=hosted.set\n"
                 f"Symbol={broker.get('symbol', 'EURUSD')}\nPeriod=M15\n")
        path = os.path.join(d, "start.ini")
        with open(path, "w", encoding="utf-8") as f:
            f.write(start)
        os.chmod(path, 0o600)
        return None

    def launch(self):
        # MT5 reopens the charts its profile saved and then opens the startup chart: without this, every start
        # adds one more chart to draw
        shutil.rmtree(os.path.join(self.dir, "MQL5", "Profiles", "Charts"), ignore_errors=True)
        self.proc = subprocess.Popen(["wine", f"C:\\slots\\t{self.id}\\terminal64.exe", "/portable",
                                      f"/config:C:\\slots\\t{self.id}\\start.ini"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.started_at = time.monotonic()
        self.auth_failures = 0
        self.offsets.clear()  # Read the logs of this run only, from where they are now
        for folder in ("logs", "MQL5/Logs", "MQL5/logs"):
            log = newest_log(os.path.join(self.dir, folder))
            if log:
                self.offsets[log] = os.path.getsize(log)
        self.status, self.detail = "starting", None

    def read_logs(self):
        """Moves the state on from the lines the terminal wrote since the last look."""
        for folder in ("logs", "MQL5/Logs", "MQL5/logs"):
            log = newest_log(os.path.join(self.dir, folder))
            if not log:
                continue
            size = os.path.getsize(log)
            start = self.offsets.get(log, 0)
            if size <= start:
                continue
            with open(log, "rb") as f:
                f.seek(start - start % 2)
                text = f.read().decode("utf-16-le", errors="replace").lstrip("\ufeff")
            self.offsets[log] = size
            for line in text.splitlines():
                if folder == "logs":
                    self.journal_line(line)
                    continue
                for pattern, status, detail in EXPERTS:
                    if pattern.search(line):
                        self.status, self.detail = status, detail
                        break

    def journal_line(self, line: str):
        refused = AUTH_FAILED.search(line)
        if refused:
            reason = refused.group(1)
            self.auth_failures += 1
            if reason == "Invalid account" or self.auth_failures >= AUTH_RETRIES:
                self.status, self.detail = "login_failed", f"A corretora recusou o login ({reason}): confira a senha e o servidor"
            else:
                self.status, self.detail = "starting", f"A corretora recusou o login ({reason}); o terminal tenta de novo"
        elif AUTHORIZED.search(line):
            self.auth_failures = 0
            if self.status in ("starting", "restarting") or self.detail == NO_BROKER:
                self.status, self.detail = "starting", CONNECTED

    def report(self) -> dict:
        return {"id": self.id, "config_version": self.version, "status": self.status, "detail": self.detail}


def set_webrequest_list(common_ini: str):
    path = os.path.join(POD_DIR, "webrequest_url.txt")
    if not os.path.exists(path) or not os.path.exists(common_ini):
        return
    with open(path, encoding="utf-8") as f:
        line = f.read().strip()
    lines = [line if l.startswith("WebRequestUrl=") else l for l in read_utf16(common_ini).lstrip("\ufeff").splitlines()]
    if line not in lines:
        lines.insert(next((i + 1 for i, l in enumerate(lines) if l.strip() == "[Experts]"), len(lines)), line)
    with open(common_ini, "wb") as f:
        f.write(utf16("\n".join(lines) + "\n"))


class Agent:
    def __init__(self):
        self.slots: Dict[int, Slot] = {}
        self.next_start = 0.0
        with open(os.path.join(POD_DIR, "brokers", "brokers.json"), encoding="utf-8") as f:
            self.brokers = json.load(f)

    def call_api(self) -> Optional[List[dict]]:
        body = {"capacity": CAPACITY, "terminals": [s.report() for s in self.slots.values() if s.version],
                "info": {"agent": VERSION, "servers": sorted(self.brokers), "memory_mb": memory_mb(),
                         "running": sum(1 for s in self.slots.values() if s.running())}}
        req = urllib.request.Request(f"{API_URL}/pods/sync", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {POD_KEY}"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return json.loads(resp.read())["terminals"]
        except urllib.error.HTTPError as e:
            logger.error(f"Sync refused: HTTP {e.code} {e.read()[:200].decode(errors='replace')}")
        except Exception as e:
            logger.warning(f"Sync failed ({type(e).__name__}): terminals keep running")
        return None

    def reconcile(self, desired: List[dict]):
        wanted = {t["id"]: t for t in desired}
        for tid in list(self.slots):
            if tid not in wanted:  # Removed from hosting
                slot = self.slots.pop(tid)
                slot.stop()
                retire(slot.dir)
        for tid, t in wanted.items():
            slot = self.slots.get(tid) or self.slots.setdefault(tid, Slot(tid))
            if not t["enabled"]:
                if slot.running():
                    slot.stop()
                    logger.info(f"t{tid}: stopped (disabled)")
                slot.version, slot.can_start, slot.status, slot.detail = t["config_version"], False, "stopped", None
                continue
            if t["config_version"] != slot.version:
                if slot.running():
                    slot.stop()
                slot.version, slot.config, slot.failures, slot.retry_at = t["config_version"], t, 0, 0.0
                error = slot.prepare(t, self.brokers)
                slot.can_start = error is None
                slot.status, slot.detail = ("error", error) if error else ("starting", "Na fila para iniciar")
                if error:
                    logger.warning(f"t{tid}: {error}")
        # Folders of terminals this agent no longer runs (left by an earlier run)
        if os.path.isdir(SLOTS_DIR):
            for name in os.listdir(SLOTS_DIR):
                if re.fullmatch(r"t\d+", name) and int(name[1:]) not in wanted:
                    retire(os.path.join(SLOTS_DIR, name))
        purge_retired()

    def supervise(self):
        now = time.monotonic()
        for slot in self.slots.values():
            if not slot.can_start:
                continue
            if slot.running():
                slot.read_logs()
                if slot.status == "login_failed":
                    slot.stop()
                    slot.can_start = False  # Retrying the same password could get the account locked
                    logger.warning(f"t{slot.id}: login refused; waiting for a new configuration")
                elif slot.status == "starting" and slot.detail is None and now - slot.started_at > LOGIN_TIMEOUT_S:
                    slot.status, slot.detail = "error", NO_BROKER
                continue
            if slot.started_at:  # It was running and exited on its own
                slot.read_logs()
                slot.started_at = 0.0
                if slot.status == "login_failed":
                    slot.can_start = False
                    continue
                slot.failures += 1
                wait = BACKOFF_S[min(slot.failures, len(BACKOFF_S)) - 1]
                slot.retry_at = now + wait
                slot.status, slot.detail = "restarting", f"O terminal fechou; nova tentativa em {wait} s"
                logger.warning(f"t{slot.id}: terminal exited, restarting in {wait} s")
                continue
            if now >= slot.retry_at and now >= self.next_start:
                slot.launch()
                self.next_start = now + STAGGER_SECONDS
                logger.info(f"t{slot.id}: started (configuration {slot.version})")

    def stop_all(self):
        logger.info("Stopping every terminal")
        for slot in self.slots.values():
            slot.stop()
        subprocess.run(["wineserver", "-k"], check=False)


def retire(folder: str):
    """Moves a removed terminal's folder aside; purge_retired deletes it later."""
    if not os.path.isdir(folder):
        return
    trash = os.path.join(SLOTS_DIR, ".removed")
    os.makedirs(trash, exist_ok=True)
    target = os.path.join(trash, f"{os.path.basename(folder)}-{int(time.time())}")
    shutil.move(folder, target)
    logger.info(f"{os.path.basename(folder)}: removed, folder kept as {target}")


def purge_retired():
    trash = os.path.join(SLOTS_DIR, ".removed")
    if not os.path.isdir(trash):
        return
    for name in os.listdir(trash):
        path = os.path.join(trash, name)
        if time.time() - os.path.getmtime(path) > RETIRED_DAYS * 86400:
            shutil.rmtree(path, ignore_errors=True)


def memory_mb() -> Optional[int]:
    try:
        with open("/sys/fs/cgroup/memory.current") as f:
            return int(f.read()) // 1048576
    except (OSError, ValueError):
        return None


def start_display():
    if os.path.exists("/tmp/.X99-lock"):
        os.remove("/tmp/.X99-lock")
    subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1280x1024x24", "-ac", "+extension", "GLX"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    # One Wine virtual desktop for every terminal: /portable breaks without it
    for key, name, value in (("Explorer", "Desktop", "MT5"), ("Explorer\\Desktops", "MT5", "1280x1024"),
                             ("X11 Driver", "UseTakeFocus", "N")):
        subprocess.run(["wine", "reg", "add", f"HKEY_CURRENT_USER\\Software\\Wine\\{key}", "/v", name, "/d", value, "/f"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not POD_KEY.startswith("pod_"):
        raise SystemExit("POD_KEY (pod_...) is required: python create_pod.py <name> on the API")
    os.environ.update(DISPLAY=":99", WINEDEBUG="-all")
    os.makedirs(SLOTS_DIR, exist_ok=True)
    agent = Agent()
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    start_display()
    logger.info(f"Pod agent {VERSION}: {API_URL}, capacity {CAPACITY}, hub {WS_HOST}:{WS_PORT}, "
                f"servers {', '.join(sorted(agent.brokers))}")
    next_sync = 0.0
    while not stopping:
        if time.monotonic() >= next_sync:
            desired = agent.call_api()
            if desired is not None:
                agent.reconcile(desired)
            next_sync = time.monotonic() + SYNC_SECONDS
        agent.supervise()
        time.sleep(2)
    agent.stop_all()


if __name__ == "__main__":
    main()
