#!/bin/bash
# Hosted-terminal spike: N MetaTrader 5 terminals in /portable mode sharing one Xvfb and one Wine
# prefix. Each terminal gets its own folder (a "slot"), logs into its own account and runs one EA
# attached by the startup config. Results go to /spike/out:
#   metrics.csv  one line per terminal, plus one for the whole container, every METRICS_SECONDS
#   pod.log      what this script did
#   logs/        each terminal's journal and experts log, converted to UTF-8
set -uo pipefail

SLOTS="${SLOTS:-3}"
EA="${EA:-probe}"                         # probe: no account needed; slave: the copy EA, one account per slot
STAGGER_SECONDS="${STAGGER_SECONDS:-45}"  # A starting terminal pegs a CPU: never start them all at once
METRICS_SECONDS="${METRICS_SECONDS:-30}"
SYMBOL="${SYMBOL:-EURUSD}"
API_URL="${API_URL:-http://api.spike.test:8000}"  # The WebRequest list refuses hostnames without a dot
HUB_HOST="${HUB_HOST:-tdm-spike-hub}"
PORTFOLIO_KEY="${PORTFOLIO_KEY:-spike-portfolio-key}"
ACCOUNTS=/spike/private/accounts.json     # [{"login": 123, "password": "...", "server": "MetaQuotes-Demo"}, ...]

BASE=/root/.wine64/drive_c/MT5
SLOTS_DIR=/root/.wine64/drive_c/slots
OUT=/spike/out
export DISPLAY=:99 WINEDEBUG=-all
mkdir -p "$OUT/logs" "$SLOTS_DIR"

log() { echo "$(date -u +%FT%TZ) [pod] $*" | tee -a "$OUT/pod.log"; }

# MT5 writes .set and its logs as UTF-16LE with BOM
utf16() { printf '\xff\xfe'; sed 's/$/\r/' | iconv -f UTF-8 -t UTF-16LE; }
utf8() { iconv -f UTF-16LE -t UTF-8 "$1" 2>/dev/null | sed '1s/^\xEF\xBB\xBF//' | tr -d '\r'; }

case "$EA" in
    probe) EA_NAME="Trademetric Spike Probe" ;;
    slave) EA_NAME="Trademetric Copy Trader Slave" ;;
    *) log "EA must be probe or slave, not $EA"; exit 1 ;;
esac
if [ "$EA" = "slave" ] && [ "$(jq length "$ACCOUNTS" 2>/dev/null || echo 0)" -lt "$SLOTS" ]; then
    log "EA=slave needs $SLOTS accounts in $ACCOUNTS"
    exit 1
fi

slot_name() { printf '%02d' "$1"; }

# Copy of the image's warmed MT5 without the worker's chart profiles. MetaEditor and the tester go
# too: LiveUpdate downloads them (~57 MB per terminal) when they are missing or older than the terminal.
make_slot() {
    local d="$SLOTS_DIR/$1"
    if [ ! -f "$d/terminal64.exe" ]; then
        mkdir -p "$d"
        cp -a "$BASE/terminal64.exe" "$BASE/MetaEditor64.exe" "$BASE/metatester64.exe" "$BASE/Terminal.ico" \
            "$BASE/Sounds" "$BASE/MQL5" "$BASE/config" "$d/"
        rm -rf "$d/MQL5/Profiles/Charts/"* "$d/MQL5/logs/"* "$d/logs" "$d/config/accounts.dat"
        # A new folder recompiles every source under MQL5 on its first start: keep only what runs
        rm -rf "$d/MQL5/Experts/"* "$d/MQL5/Indicators/"* "$d/MQL5/Scripts/"* "$d/MQL5/Services/"* \
            "$d/MQL5/Include" "$d/MQL5/Images"
        log "slot $1 created ($(du -sm "$d" | cut -f1) MB)"
    fi
    # The broker's servers: without them the terminal silently never connects
    [ -f /opt/spike/ea/servers.dat ] && cp /opt/spike/ea/servers.dat "$d/config/servers.dat"
    set_webrequest_list "$d/config/common.ini"
    # The worker's Default.tpl carries its own EA: applied to the startup chart, it replaces ours
    rm -f "$d/MQL5/Profiles/Templates/Default.tpl"
    mkdir -p "$d/MQL5/Experts/TDM" "$d/MQL5/Libraries" "$d/MQL5/Presets"
    cp /opt/spike/ea/*.ex5 "$d/MQL5/Experts/TDM/"
    cp /opt/spike/ea/*.dll "$d/MQL5/Libraries/"
}

# The WebRequest allowed list is stored encrypted in common.ini and cannot come from start.ini.
# webrequest_url.txt holds a "WebRequestUrl=..." line saved by a terminal of this same image (Tools >
# Options, started without /config, which is the only way the terminal writes common.ini). Copied to
# another slot folder it still works; a line from another machine does not.
set_webrequest_list() {
    local f="$1" line
    [ -f /opt/spike/ea/webrequest_url.txt ] || return 0
    line=$(tr -d '\r\n' < /opt/spike/ea/webrequest_url.txt)
    utf8 "$f" | sed "s|^WebRequestUrl=.*|$line|" | utf16 > "$f.new" && mv "$f.new" "$f"
}

write_config() {
    local n="$1" i="$2" d="$SLOTS_DIR/$1" common=""
    # Without a logged-in account the chart gets no data and MT5 never runs the EA's OnInit
    if [ "$(jq length "$ACCOUNTS" 2>/dev/null || echo 0)" -gt "$i" ]; then
        common=$(jq -r --argjson i "$i" '.[$i] | "Login=\(.login)\nPassword=\(.password)\nServer=\(.server)"' "$ACCOUNTS")
    fi
    if [ "$EA" = "slave" ]; then
        utf16 > "$d/MQL5/Presets/spike.set" <<EOF
inp_host=$HUB_HOST
inp_port=5556
inp_push_port=5557
inp_api_url=$API_URL
inp_connection_key=$PORTFOLIO_KEY
EOF
    else
        utf16 > "$d/MQL5/Presets/spike.set" <<EOF
InpUrl=$API_URL/health
InpHub=tcp://$HUB_HOST:5556
EOF
    fi
    # WebRequest=1 ticks "Allow WebRequest for listed URL", but the list itself is not read from here:
    # it lives encrypted in config/common.ini (WebRequestUrl=), filled through Tools > Options
    cat > "$d/start.ini" <<EOF
[Common]
$common
NewsEnable=0
[Charts]
MaxBars=1000
PreloadCharts=0
[Experts]
AllowLiveTrading=1
AllowDllImport=1
Enabled=1
Account=0
Profile=0
WebRequest=1
[StartUp]
Expert=TDM\\$EA_NAME
ExpertParameters=spike.set
Symbol=$SYMBOL
Period=M15
EOF
}

# The terminal's process is the one whose command line is that slot's terminal64.exe
slot_pid() {
    local p
    for p in /proc/[0-9]*; do
        tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "slots\\$1\\terminal64.exe" && echo "${p#/proc/}"
    done | sort -n | tail -1
}

copy_logs() {
    local n="$1" d="$SLOTS_DIR/$1" f
    for f in "$d"/logs/*.log; do [ -f "$f" ] && utf8 "$f"; done > "$OUT/logs/slot-$n-journal.log"
    # The image's folder is MQL5/logs; Wine resolves either case to it
    for f in "$d"/MQL5/[Ll]ogs/*.log; do [ -f "$f" ] && utf8 "$f"; done > "$OUT/logs/slot-$n-experts.log"
}

metrics() {
    local hz ts n pid stat rest pss rss ticks cpu threads mem usage last_usage=""
    declare -A last
    hz=$(getconf CLK_TCK)
    [ -f "$OUT/metrics.csv" ] || echo "ts,slot,pid,pss_mb,rss_mb,cpu_pct,threads" > "$OUT/metrics.csv"
    while true; do
        ts=$(date -u +%FT%TZ)
        for i in $(seq 1 "$SLOTS"); do
            n=$(slot_name "$i")
            [ -d "$SLOTS_DIR/$n" ] || continue
            copy_logs "$n"
            pid=$(slot_pid "$n")
            if [ -z "$pid" ]; then
                echo "$ts,$n,,,,," >> "$OUT/metrics.csv"
                continue
            fi
            stat=$(cat "/proc/$pid/stat" 2>/dev/null) || continue
            rest=${stat##*) }
            set -- $rest  # Fields from 3 on: utime is field 14, stime 15, num_threads 20
            ticks=$(( ${12} + ${13} ))
            threads=${18}
            cpu=""
            [ -n "${last[$pid]:-}" ] && cpu=$(( (ticks - last[$pid]) * 100 / (hz * METRICS_SECONDS) ))
            last[$pid]=$ticks
            pss=$(awk '/^Pss:/ {print int($2 / 1024)}' "/proc/$pid/smaps_rollup" 2>/dev/null)
            rss=$(awk '/^VmRSS:/ {print int($2 / 1024)}' "/proc/$pid/status" 2>/dev/null)
            echo "$ts,$n,$pid,$pss,$rss,$cpu,$threads" >> "$OUT/metrics.csv"
        done
        # Whole container (Xvfb, wineserver and every terminal) from its cgroup
        mem=$(( $(cat /sys/fs/cgroup/memory.current) / 1048576 ))
        usage=$(awk '/^usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat)
        cpu=""
        [ -n "$last_usage" ] && cpu=$(( (usage - last_usage) / (METRICS_SECONDS * 10000) ))
        last_usage=$usage
        echo "$ts,all,,$mem,,$cpu," >> "$OUT/metrics.csv"
        for lu in /root/.wine64/drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/*/liveupdate; do
            [ -n "$(find "$lu" -type f 2>/dev/null | head -1)" ] && log "liveupdate: $(du -sm "$lu" | cut -f1) MB in $lu"
        done
        sleep "$METRICS_SECONDS"
    done
}

stop() {
    log "stopping: closing the terminals"
    # Settings changed in Tools > Options only reach config/common.ini on a clean exit, and a terminal
    # logged into a broker with tens of thousands of symbols takes a while to close
    wine taskkill /IM terminal64.exe >/dev/null 2>&1
    for _ in $(seq 1 60); do
        pgrep -f 'terminal64.exe' >/dev/null || break
        sleep 1
    done
    for i in $(seq 1 "$SLOTS"); do copy_logs "$(slot_name "$i")"; done
    wineserver -k 2>/dev/null
    exit 0
}
trap stop TERM INT

log "pod: $SLOTS slots, EA=$EA, stagger ${STAGGER_SECONDS}s, symbol $SYMBOL"
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x1024x24 -ac +extension GLX >/dev/null 2>&1 &
sleep 2
# One Wine virtual desktop for every terminal; /portable breaks without it (Drawdown Guard worker)
wine reg add 'HKEY_CURRENT_USER\Software\Wine\Explorer' /v Desktop /d MT5 /f >/dev/null 2>&1
wine reg add 'HKEY_CURRENT_USER\Software\Wine\Explorer\Desktops' /v MT5 /d 1280x1024 /f >/dev/null 2>&1
wine reg add 'HKEY_CURRENT_USER\Software\Wine\X11 Driver' /v UseTakeFocus /d N /f >/dev/null 2>&1

metrics &

for i in $(seq 1 "$SLOTS"); do
    n=$(slot_name "$i")
    make_slot "$n"
    write_config "$n" "$((i - 1))"
    wine "C:\\slots\\$n\\terminal64.exe" /portable "/config:C:\\slots\\$n\\start.ini" >/dev/null 2>&1 &
    log "slot $n started"
    [ "$i" -lt "$SLOTS" ] && sleep "$STAGGER_SECONDS"
done
log "all $SLOTS slots started"
wait
