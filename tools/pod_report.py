"""Sizes the hosted-terminal VPS from what tools/pod_measure.sh sampled on a pod's host.

    python tools/pod_report.py <measure dir> [--pod tdm-spike-pod]

One row per phase (the stretch between two marks) and per number of terminals running, then what one
terminal costs on top of the pod's fixed part (Xvfb, wineserver, the agent). CPU is in % of one core.
"""
import argparse
import csv
import os
import statistics
from collections import defaultdict


def pct(values, q):
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def load(directory):
    samples = defaultdict(lambda: defaultdict(list))  # ts -> kind -> [(name, cpu, mem)]
    with open(os.path.join(directory, "samples.csv"), newline="") as f:
        for row in csv.DictReader(f):
            cpu = float(row["cpu_pct"] or 0)
            mem = float(row["mem_mb"]) if row["mem_mb"] else None
            samples[row["ts"]][row["kind"]].append((row["name"], cpu, mem))
    marks = []
    path = os.path.join(directory, "marks.csv")
    if os.path.exists(path):
        with open(path, newline="") as f:
            marks = [(r[0], ",".join(r[1:])) for r in csv.reader(f) if r]
    return samples, sorted(marks)


def summarize(rows, pod):
    """rows: [(ts, kinds)] -> one dict of figures, or None without process samples."""
    pod_cpu, pod_mem, host_cpu, avail, thr = [], [], [], [], []
    term_cpu, term_mem, fixed_cpu, fixed_mem, others = [], [], [], [], defaultdict(list)
    terminals = []
    for _, kinds in rows:
        procs = kinds.get("proc", [])
        if not procs:
            continue
        terms = [p for p in procs if p[0].startswith("t") and p[0][1:].isdigit()]
        rest = [p for p in procs if p not in terms]
        terminals.append(len(terms))
        pod_cpu.append(sum(p[1] for p in procs))
        term_cpu.extend(p[1] for p in terms)
        term_mem.extend(p[2] or 0 for p in terms)
        fixed_cpu.append(sum(p[1] for p in rest))
        fixed_mem.append(sum(p[2] or 0 for p in rest))
        for name, cpu, mem in kinds.get("container", []):
            if name == pod:
                pod_mem.append(mem or 0)
            else:
                others[name].append(cpu)
        for name, cpu, mem in kinds.get("host", []):
            if name == "cpu":
                host_cpu.append(cpu)
                avail.append(mem or 0)
        thr.extend(c for _, c, _ in kinds.get("throttle", []))
    if not pod_cpu:
        return None
    return {
        "samples": len(pod_cpu),
        "terminals": statistics.mode(terminals),
        "pod_cpu": (statistics.mean(pod_cpu), pct(pod_cpu, 0.95), max(pod_cpu)),
        "pod_mem": max(pod_mem) if pod_mem else 0,
        "term_cpu": (statistics.mean(term_cpu), pct(term_cpu, 0.95)) if term_cpu else (0, 0),
        "term_mem": statistics.mean(term_mem) if term_mem else 0,
        "fixed_cpu": statistics.mean(fixed_cpu),
        "fixed_mem": statistics.mean(fixed_mem),
        "host_cpu": (statistics.mean(host_cpu), pct(host_cpu, 0.95)) if host_cpu else (0, 0),
        "avail_min": min(avail) if avail else 0,
        "throttle": statistics.mean(thr) if thr else 0,
        "others": {n: statistics.mean(v) for n, v in others.items()},
    }


def table(title, groups, pod):
    print(f"\n## {title}\n")
    print("| trecho | amostras | terminais | CPU do pod média / p95 / máx | RAM do pod máx | "
          "CPU por terminal média / p95 | RAM por terminal | parte fixa CPU / RAM | host CPU média / p95 | "
          "RAM livre mín | throttle |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    results = []
    for label, rows in groups:
        s = summarize(rows, pod)
        if not s:
            continue
        results.append(s)
        print(f"| {label} | {s['samples']} | {s['terminals']} | "
              f"{s['pod_cpu'][0]:.0f}% / {s['pod_cpu'][1]:.0f}% / {s['pod_cpu'][2]:.0f}% | {s['pod_mem']:.0f} MB | "
              f"{s['term_cpu'][0]:.1f}% / {s['term_cpu'][1]:.1f}% | {s['term_mem']:.0f} MB | "
              f"{s['fixed_cpu']:.1f}% / {s['fixed_mem']:.0f} MB | {s['host_cpu'][0]:.0f}% / {s['host_cpu'][1]:.0f}% | "
              f"{s['avail_min']:.0f} MB | {s['throttle']:.1f}% |")
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--pod", default="tdm-spike-pod")
    args = parser.parse_args()
    samples, marks = load(args.directory)
    stamps = sorted(samples)

    phases, bounds = [], [("início", "")] + [(text, ts) for ts, text in marks]
    for i, (label, start) in enumerate(bounds):
        end = bounds[i + 1][1] if i + 1 < len(bounds) else "9999"
        rows = [(ts, samples[ts]) for ts in stamps if start <= ts < end]
        phases.append((f"{start[11:16] or stamps[0][11:16]} {label}", rows))
    table("Por trecho (entre as marcas)", phases, args.pod)

    by_n = defaultdict(list)
    for ts in stamps:
        n = sum(1 for p in samples[ts].get("proc", []) if p[0].startswith("t") and p[0][1:].isdigit())
        by_n[n].append((ts, samples[ts]))
    results = table("Por número de terminais", [(f"{n} terminais", by_n[n]) for n in sorted(by_n)], args.pod)

    steady = [s for s in results if s["terminals"] > 0]
    if steady:
        cpu = max(s["term_cpu"][1] for s in steady)
        mem = max(s["term_mem"] for s in steady)
        fixed_cpu = max(s["fixed_cpu"] for s in steady)
        fixed_mem = max(s["fixed_mem"] for s in steady)
        print("\n## Por terminal, para dimensionar\n")
        print(f"- CPU: {cpu:.1f}% de um núcleo no p95; parte fixa do pod {fixed_cpu:.1f}%")
        print(f"- RAM: {mem:.0f} MB; parte fixa do pod {fixed_mem:.0f} MB")
        print("- Terminais por pod, deixando 30% de folga de CPU e 20% de RAM:")
        for cores, gb in ((1, 2), (2, 4), (4, 8), (8, 16)):
            by_cpu = (cores * 100 * 0.7 - fixed_cpu) / cpu if cpu else float("inf")
            by_mem = (gb * 1024 * 0.8 - fixed_mem) / mem if mem else float("inf")
            print(f"  - {cores} vCPU / {gb} GB: {int(max(0, min(by_cpu, by_mem)))} "
                  f"(CPU daria {int(max(0, by_cpu))}, RAM daria {int(max(0, by_mem))})")
        print("- Não inclui a subida de um terminal (~1 núcleo por ~15 s): o STAGGER_SECONDS do pod cuida disso.")


if __name__ == "__main__":
    main()
