#!/bin/bash
# What the hosted-terminal pod costs its host, for sizing the VPS. Read-only: /proc, the pod's cgroup
# and docker stats. Run on the pod's host:
#   ./pod_measure.sh [container] [seconds]   samples until Ctrl+C (defaults: tdm-spike-pod, 15)
#   ./pod_measure.sh mark "text"             notes an event: a terminal added, a copy burst, market close
# Writes to $MEASURE_DIR (default ~/tdm-measure), read by tools/pod_report.py:
#   samples.csv  ts,kind,name,cpu_pct,mem_mb   cpu_pct is of one core (200 = two cores busy)
#     host,cpu        whole host; mem_mb = MemAvailable
#     host,load       1-min load average in cpu_pct
#     container,<n>   every container from docker stats (the pod, Korman, ...)
#     proc,<n>        each process in the pod: t<id> is the terminal of hosted terminal <id>
#     throttle,<pod>  share of the interval the pod spent throttled by --cpus, in cpu_pct
#   marks.csv    ts,text
set -uo pipefail

DIR="${MEASURE_DIR:-$HOME/tdm-measure}"
mkdir -p "$DIR"
if [ "${1:-}" = mark ]; then
    echo "$(date -u +%FT%TZ),${2:-mark}" >> "$DIR/marks.csv"
    echo "marked: ${2:-mark}"
    exit 0
fi

POD="${1:-tdm-spike-pod}"
EVERY="${2:-15}"
HZ=$(getconf CLK_TCK)
NCPU=$(nproc)
OUT="$DIR/samples.csv"
[ -f "$OUT" ] || echo "ts,kind,name,cpu_pct,mem_mb" > "$OUT"

pod_cgroup() {
    local id
    id=$(docker inspect -f '{{.Id}}' "$POD" 2>/dev/null) || return
    for d in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
        [ -f "$d/cpu.stat" ] && { echo "$d"; return; }
    done
}

# A terminal is named by its slot (c:\slots\t38\terminal64.exe -> t38), the rest by their command
TERMINAL_RE='slots[\\/](t[0-9]+)[\\/]terminal64\.exe'
proc_name() {
    local argv0
    argv0=$(tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | head -1)
    if [[ "${argv0,,}" =~ $TERMINAL_RE ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        basename "${argv0//\\//}" | tr ',' '_'
    fi
}

declare -A prev_ticks
prev_busy=0 prev_total=0 prev_thr=-1 prev_t=0
echo "sampling $POD every ${EVERY}s into $OUT (Ctrl+C to stop; '$0 mark \"text\"' notes an event)"

while true; do
    ts=$(date -u +%FT%TZ)
    now=$(date +%s.%N)
    {
        read -r _ u n s i w irq sirq st _ < /proc/stat
        busy=$((u + n + s + irq + sirq + st)) total=$((busy + i + w))
        avail=$(awk '/^MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
        if [ "$prev_total" -gt 0 ]; then
            awk -v b=$((busy - prev_busy)) -v t=$((total - prev_total)) -v c="$NCPU" -v ts="$ts" -v a="$avail" \
                'BEGIN { printf "%s,host,cpu,%.1f,%s\n", ts, (t > 0 ? 100 * c * b / t : 0), a }'
        fi
        prev_busy=$busy prev_total=$total
        awk -v ts="$ts" '{ printf "%s,host,load,%.0f,\n", ts, 100 * $1 }' /proc/loadavg

        docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null |
            awk -F, -v ts="$ts" '{
                cpu = $2; sub(/%/, "", cpu)
                split($3, m, " / "); v = m[1]; mb = v + 0
                if (v ~ /GiB/) mb *= 1024; else if (v ~ /KiB/) mb /= 1024; else if (v ~ /B$/ && v !~ /iB/) mb /= 1048576
                printf "%s,container,%s,%s,%.0f\n", ts, $1, cpu, mb }'

        dt=$(awk -v a="$now" -v b="$prev_t" 'BEGIN { print (b > 0 ? a - b : 0) }')
        declare -A seen=()
        for pid in $(docker top "$POD" -eo pid 2>/dev/null | tail -n +2); do
            [ -r "/proc/$pid/stat" ] || continue
            # utime and stime are fields 14 and 15, counted after the ")" that ends the command name
            ticks=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{ print $12 + $13 }')
            rss=$(awk '/^VmRSS/ {print int($2 / 1024)}' "/proc/$pid/status" 2>/dev/null)
            seen[$pid]=1
            if [ -n "${prev_ticks[$pid]:-}" ] && awk -v d="$dt" 'BEGIN { exit !(d > 0) }'; then
                awk -v ts="$ts" -v n="$(proc_name "$pid")" -v d=$((ticks - prev_ticks[$pid])) -v hz="$HZ" \
                    -v dt="$dt" -v r="${rss:-0}" 'BEGIN { printf "%s,proc,%s,%.1f,%s\n", ts, n, 100 * d / hz / dt, r }'
            fi
            prev_ticks[$pid]=$ticks
        done
        for pid in "${!prev_ticks[@]}"; do [ -n "${seen[$pid]:-}" ] || unset "prev_ticks[$pid]"; done

        cg=$(pod_cgroup)
        if [ -n "$cg" ]; then
            thr=$(awk '/^throttled_usec/ {print $2}' "$cg/cpu.stat")
            if [ "$prev_thr" -ge 0 ] && [ -n "$thr" ]; then
                awk -v ts="$ts" -v p="$POD" -v d=$((thr - prev_thr)) -v dt="$dt" \
                    'BEGIN { printf "%s,throttle,%s,%.1f,\n", ts, p, (dt > 0 ? d / 1e4 / dt : 0) }'
            fi
            prev_thr=${thr:--1}
        fi
    } >> "$OUT"
    prev_t=$now
    sleep "$EVERY"
done
