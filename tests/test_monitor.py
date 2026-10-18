from datetime import datetime, timezone

import monitor

MONDAY_10H = datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)  # 10:00 in Brasília
MONDAY_20H = datetime(2026, 10, 19, 23, 0, tzinfo=timezone.utc)
SATURDAY_10H = datetime(2026, 10, 17, 13, 0, tzinfo=timezone.utc)


def health(**hub):
    body = {"status": "healthy", "schema": "ready",
            "hub": {"status": "healthy", "warming": False, "db_ok": True, "db_dropped": 0, "db_failed": 0,
                    "last_master_msg_age_seconds": 4.0, "ws": {"masters": 1, "slaves": 3}}}
    body["hub"].update(hub)
    return body


def run(m, rounds, api_status=200, api=None, signals=200, now=MONDAY_10H):
    messages = []
    for _ in range(rounds):
        results, events = m.evaluate(api_status, api if api is not None else health(), signals, now)
        messages += events + m.step(results)
    return messages


def test_healthy_sends_nothing():
    assert run(monitor.Monitor(), 5) == []


def test_problem_reported_after_failures_in_a_row_then_back():
    m = monitor.Monitor()
    assert run(m, monitor.FAILURES - 1, api_status=0) == []
    down = run(m, 3, api_status=0)
    assert len(down) == 1 and down[0].startswith("🔴") and "não responde" in down[0]
    back = run(m, 1)
    assert back == ["🟢 Normalizado: " + down[0][2:]]


def test_a_passing_round_resets_the_count():
    m = monitor.Monitor()
    run(m, monitor.FAILURES - 1, api_status=0)
    run(m, 1)
    assert run(m, monitor.FAILURES - 1, api_status=0) == []


def test_database_and_schema():
    assert "sem banco" in run(monitor.Monitor(), monitor.FAILURES, api_status=503,
                              api={"status": "error", "database": "unavailable", "schema": "ready"})[0]
    assert "pending" in run(monitor.Monitor(), monitor.FAILURES, api_status=503,
                            api={"status": "starting", "schema": "pending", "hub": {}})[0]


def test_stalled_hub_keeps_the_master_check_as_it_was():
    m = monitor.Monitor()
    no_master = run(m, monitor.FAILURES, api=health(ws={"masters": 0}))
    assert no_master == ["🔴 Nenhum Master conectado ao hub no pregão"]
    # The hub stalls: no data on Masters, so no "back to normal" for them
    assert run(m, monitor.FAILURES, api=health(status="stalled")) == ['🔴 O hub está "stalled": as cópias param']
    assert sorted(run(m, 1)) == sorted(['🟢 Normalizado: O hub está "stalled": as cópias param',
                                        "🟢 Normalizado: Nenhum Master conectado ao hub no pregão"])


def test_masters_only_checked_in_the_session():
    no_master = health(ws={"masters": 0})
    assert run(monitor.Monitor(), 5, api=no_master, now=MONDAY_20H) == []
    assert run(monitor.Monitor(), 5, api=no_master, now=SATURDAY_10H) == []


def test_quiet_master():
    messages = run(monitor.Monitor(), monitor.FAILURES, api=health(last_master_msg_age_seconds=300.0))
    assert messages == ["🔴 O Master está conectado, mas não manda nada há 300 s"]


def test_signals_edge_down():
    assert "signals.trademetric.com.br" in run(monitor.Monitor(), monitor.FAILURES, signals=0)[0]


def test_lost_writes_reported_at_once_and_a_restarted_hub_counts_again():
    m = monitor.Monitor()
    assert run(m, 1, api=health(db_dropped=2)) == []  # Baseline
    assert run(m, 1, api=health(db_dropped=5, db_failed=1)) == [
        "⚠️ O hub perdeu 4 gravações no banco (sinais ou relatórios)"]
    assert run(m, 1, api=health()) == []  # Hub restarted: counters back to 0
    assert len(run(m, 1, api=health(db_failed=1))) == 1


def test_session_boundaries():
    def at(hour, minute, day=19):  # 19/10/2026 is a Monday
        return datetime(2026, 10, day, hour + 3, minute, tzinfo=timezone.utc)
    assert not monitor.in_session(at(8, 59))
    assert monitor.in_session(at(9, 0))
    assert monitor.in_session(at(18, 29))
    assert not monitor.in_session(at(18, 30))
    assert not monitor.in_session(at(10, 0, day=18))  # Sunday
