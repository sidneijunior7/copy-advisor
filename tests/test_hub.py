import pytest

import hub
from hub import Directory, HubCore, ManagerInfo, MasterKeyInfo, StrategyInfo

MANAGER = ManagerInfo(id=1, status="active")
STRATEGY = StrategyInfo(id=10, manager_id=1, name="Trend", is_active=True)


def make_directory(manager=MANAGER, strategy=STRATEGY, portfolios=(7, 8)):
    return Directory(
        managers_by_id={manager.id: manager},
        strategies_by_magic={(manager.id, 555): strategy},
        strategies_by_id={strategy.id: strategy},
        portfolios_by_strategy={strategy.id: tuple(portfolios)},
        portfolio_ids=tuple(portfolios),
    )


class Harness:
    """HubCore as hub_ws drives it: lines from an authenticated Master of manager 1."""

    def __init__(self, directory=None):
        self.now = 1000.0
        self.dir = directory or make_directory()
        self.published = []
        self.web = []
        self.jobs = []
        self.refreshes = 0
        self.core = HubCore(
            directory=lambda: self.dir,
            publish=lambda portfolio_id, payload: self.published.append((portfolio_id, payload)),
            web=self.web.append,
            persist=self.jobs.append,
            request_refresh=self._refresh,
            epoch=42,
            clock=lambda: self.now,
        )

    def _refresh(self):
        self.refreshes += 1

    def master(self, line):
        self.core.handle_master(self.dir.managers_by_id[1], line)

    def v2(self, reason, pos_id, vol, type_=0, sl=1.09, tp=1.12, magic=555, login=900):
        self.master(f"V2|{login}|{reason}|{pos_id}|{type_}|EURUSD|{vol}|1.10000|{sl}|{tp}|{magic}")

    def sync(self, entries, login=900):
        body = ";".join(f"{p},0,EURUSD,{v},1.10000,1.09,1.12,555" for p, v in entries)
        self.master(f"V2SYNC|{login}|{body}")

    def exec(self, uid, seq, portfolio_id=7, retcode=10009):
        self.core.handle_exec(f"EXEC|0|-|{uid}|OPEN|555001|1|1.1001|{retcode}|{seq}".split("|"),
                              portfolio_id=portfolio_id, login=12345)

    def payloads(self, prefix, portfolio_id=7):
        return [p for pid, p in self.published if pid == portfolio_id and p.startswith(prefix)]

    def clear(self):
        self.published.clear()
        self.web.clear()
        self.jobs.clear()


def test_open_publishes_state_to_every_portfolio_with_per_portfolio_seq():
    h = Harness()
    h.v2("OPEN", 123, 0.5)
    assert h.payloads("POS", 7) == ["POS|42|1|900_123|0|EURUSD|0.5|1.1|1.09|1.12|555|OPEN"]
    assert h.payloads("POS", 8) == ["POS|42|1|900_123|0|EURUSD|0.5|1.1|1.09|1.12|555|OPEN"]
    assert h.web[0]["data"]["key"] == "10_900_123"
    assert h.jobs[0]["kind"] == "position" and h.jobs[0]["closed"] is False
    assert h.jobs[0]["raw"] == "V2|900|OPEN|123|0|EURUSD|0.5|1.10000|1.09|1.12|555"

    h.v2("MODIFY", 123, 0.5, sl=1.095)
    assert h.payloads("POS")[-1].startswith("POS|42|2|900_123|")
    assert len(h.published) == 4  # One POS per portfolio for each change, nothing else


def test_unchanged_state_is_not_republished():
    h = Harness()
    h.v2("OPEN", 1, 1.0)
    h.clear()
    h.v2("MODIFY", 1, 1.0)
    assert h.published == [] and h.jobs == []


def test_partial_and_close_are_state_changes_and_close_is_terminal():
    h = Harness()
    h.v2("OPEN", 1, 1.0)
    h.v2("PARTIAL", 1, 0.3)
    h.v2("CLOSE", 1, 0)
    pos = h.payloads("POS")
    assert pos[1].split("|")[6] == "0.3"
    assert pos[2].split("|")[6] == "0"
    assert h.web[-1]["data"]["volume"] == 0
    assert h.jobs[-1]["closed"] is True

    h.clear()
    h.v2("ADD", 1, 2.0)  # Late message for a closed position must not reopen it
    assert h.published == [] and 1 not in [p.pos_id for p in h.core.positions.values()]


def test_gates_apply_only_when_a_position_is_born():
    h = Harness()
    h.v2("OPEN", 1, 1.0, magic=999)
    assert h.payloads("POS") == [] and h.core.stats["rejected"] == 1 and h.refreshes == 1

    h.v2("OPEN", 2, 1.0)
    frozen = ManagerInfo(id=1, status="frozen")
    inactive = StrategyInfo(id=10, manager_id=1, name="Trend", is_active=False)
    h.dir = make_directory(manager=frozen, strategy=inactive)
    h.clear()

    h.v2("OPEN", 3, 1.0)  # New position from a frozen manager: rejected
    assert h.published == []
    h.v2("CLOSE", 2, 0)   # Existing one still closes
    assert h.payloads("POS")[0].split("|")[6] == "0"


def test_reversal_keeps_identity_and_flips_type():
    h = Harness()
    h.v2("OPEN", 5, 1.0, type_=0)
    h.v2("REVERSE", 5, 2.0, type_=1)
    f = h.payloads("POS")[-1].split("|")
    assert (f[3], f[4], f[6], f[11]) == ("900_5", "1", "2", "REVERSE")


def test_sync_creates_missing_positions():
    h = Harness()
    h.sync([(1, 1.0)])
    assert [p.split("|")[11] for p in h.payloads("POS")] == ["SYNC"]
    assert h.jobs[0]["raw"] is None


def test_sync_closes_only_after_two_consecutive_misses():
    h = Harness()
    h.v2("OPEN", 1, 1.0)
    h.v2("OPEN", 2, 1.0)
    h.clear()
    h.sync([(2, 1.0)])
    assert h.payloads("POS") == []
    h.sync([(1, 1.0), (2, 1.0)])  # Reappeared: miss counter resets
    h.sync([(2, 1.0)])
    assert h.payloads("POS") == []
    h.sync([(2, 1.0)])
    closes = h.payloads("POS")
    assert len(closes) == 1 and closes[0].split("|")[3] == "900_1" and closes[0].split("|")[6] == "0"


def test_sync_is_scoped_to_the_master_login():
    h = Harness()
    h.v2("OPEN", 1, 1.0, login=900)
    h.v2("OPEN", 1, 1.0, login=901)
    h.clear()
    h.sync([], login=901)
    h.sync([], login=901)
    assert [p.split("|")[3] for p in h.payloads("POS")] == ["901_1"]
    assert (1, 900, 1) in h.core.positions


def test_empty_sync_body_is_accepted():
    h = Harness()
    h.master("V2SYNC|900|")
    assert h.core.stats["errors"] == 0


def test_master_lines_in_the_pre_v3_format_are_ignored():
    h = Harness()
    h.master("OPEN|77|0|EURUSD|0.5|1.1|0|0|555")
    h.v2("OPEN", 1, 1.0, magic=555)
    h.master("V2|900|OPEN|2|0|EURUSD")  # Truncated
    assert [p.split("|")[3] for p in h.payloads("POS")] == ["900_1"]


def test_heartbeat_repeats_seq_and_snapshot_waits_for_warmup():
    h = Harness()
    h.v2("OPEN", 1, 1.0)
    h.clear()
    h.core.tick()
    assert h.payloads("HB") == ["HB|42|1"]
    assert h.payloads("SNAP") == []  # Positions not loaded from the database yet

    h.core.load_positions([{
        "manager_id": 1, "master_login": 950, "pos_id": 9, "strategy_id": 10, "type": 1, "symbol": "GBPUSD",
        "volume": 2.0, "price_open": 1.3, "sl": 0.0, "tp": 0.0, "magic": 555,
    }])
    h.now += 1
    h.core.tick()
    assert h.core.warming  # Waiting for login 950 to V2SYNC

    h.master("V2SYNC|950|9,1,GBPUSD,2,1.3,0,0,555")
    h.core.tick()
    assert not h.core.warming
    snap = h.payloads("SNAP")[0].split("|", 3)
    assert snap[:3] == ["SNAP", "42", "1"]
    assert set(snap[3].split(";")) == {"900_1,0,EURUSD,1,1.1,1.09,1.12,555", "950_9,1,GBPUSD,2,1.3,0,0,555"}


def test_warmup_times_out():
    h = Harness()
    h.core.load_positions([{
        "manager_id": 1, "master_login": 950, "pos_id": 9, "strategy_id": 10, "type": 1, "symbol": "GBPUSD",
        "volume": 2.0, "price_open": 1.3, "sl": None, "tp": None, "magic": 555,
    }])
    h.now += hub.WARMUP_SECONDS
    h.core.tick()
    assert not h.core.warming and h.payloads("SNAP")


def test_load_does_not_override_live_state():
    h = Harness()
    h.v2("OPEN", 9, 3.0, login=950)
    h.core.load_positions([{
        "manager_id": 1, "master_login": 950, "pos_id": 9, "strategy_id": 10, "type": 0, "symbol": "EURUSD",
        "volume": 1.0, "price_open": 1.1, "sl": 0, "tp": 0, "magic": 555,
    }])
    assert h.core.positions[(1, 950, 9)].state.volume == 3.0


def test_positions_of_masters_without_a_login_are_left_out():
    """Pre-v3 Masters didn't send their login (stored as 0): nothing can update or close those positions now."""
    h = Harness()
    h.core.load_positions([{
        "manager_id": 1, "master_login": 0, "pos_id": 77, "strategy_id": 10, "type": 0, "symbol": "EURUSD",
        "volume": 1.0, "price_open": 1.1, "sl": 0, "tp": 0, "magic": 555,
    }])
    h.core.tick()
    assert h.core.positions == {} and not h.core.warming
    assert h.payloads("SNAP") == ["SNAP|42|0|"]


def test_empty_portfolio_gets_empty_snapshot():
    h = Harness(directory=make_directory(portfolios=(7,)))
    h.core.load_positions([])
    h.core.tick()
    assert h.payloads("SNAP") == ["SNAP|42|0|"]


def test_exec_is_persisted_with_the_session_portfolio_and_login():
    h = Harness()
    h.core.handle_exec("EXEC|999|forged|900_1|OPEN|555001|0.5|1.1001|10009|3".split("|"), portfolio_id=7, login=12345)
    job = h.jobs[0]
    assert (job["kind"], job["portfolio_id"], job["mt5_login"], job["retcode"]) == ("execution", 7, 12345, 10009)


@pytest.mark.parametrize("value,expected", [(1.1, "1.1"), (130000.0, "130000"), (0.00012345, "0.00012345"), (0.0, "0")])
def test_fmt(value, expected):
    assert hub.fmt(value) == expected


# --- PRD-03: latency from publishing a POS to the slave's execution report ---

def test_exec_latency_matches_the_pos_it_answers():
    h = Harness(directory=make_directory(portfolios=(7,)))
    h.v2("OPEN", 1, 1.0)  # Portfolio 7 seq 1, uid 900_1
    h.now += 0.25
    h.exec("900_1", 1)
    assert h.jobs[-1]["latency_ms"] == 250
    assert h.core.latency_stats() == {"count": 1, "p50": 250, "p95": 250, "max": 250}


@pytest.mark.parametrize("retcode", [10019, 10034, 10018])  # No margin, lot limit, market closed
def test_a_copy_that_did_not_happen_has_no_latency(retcode):
    h = Harness(directory=make_directory(portfolios=(7,)))
    h.v2("OPEN", 1, 1.0)
    h.exec("900_1", 1, retcode=retcode)
    assert h.jobs[-1]["latency_ms"] is None and h.jobs[-1]["retcode"] == retcode
    assert h.core.latency_stats() == {"count": 0}


def test_exec_for_another_position_or_portfolio_has_no_latency():
    h = Harness(directory=make_directory(portfolios=(7,)))
    h.v2("OPEN", 1, 1.0)
    h.exec("900_2", 1)
    h.exec("900_1", 1, portfolio_id=8)
    assert [j["latency_ms"] for j in h.jobs if j["kind"] == "execution"] == [None, None]
    assert h.core.latency_stats() == {"count": 0}


# --- V2HELLO: trade mode, server and broker of the Master account ---

def test_hello_records_the_account_without_publishing():
    h = Harness()
    h.master("V2HELLO|900|demo|XPMT5-DEMO|XP Investimentos | CCTVM")
    assert h.published == [] and h.web == []
    job = h.jobs[-1]
    assert (job["kind"], job["manager_id"], job["master_login"]) == ("master_account", 1, 900)
    assert (job["trade_mode"], job["server"], job["company"]) == ("demo", "XPMT5-DEMO", "XP Investimentos | CCTVM")
    assert h.core.masters[(1, 900)] == ("demo", "XPMT5-DEMO", "XP Investimentos | CCTVM")


def test_hello_with_unexpected_mode_or_missing_fields():
    h = Harness()
    h.master("V2HELLO|900|bogus|Srv|Co")
    assert h.jobs[-1]["trade_mode"] == "unknown"
    h.clear()
    h.master("V2HELLO|900|demo|Srv")
    assert h.jobs == []


def test_real_account_master_is_not_gated_yet():
    h = Harness()
    h.master("V2HELLO|900|real|Srv|Co")
    h.v2("OPEN", 1, 1.0)
    assert len(h.payloads("POS")) == 1


def test_master_key_use_is_recorded_hourly():
    h = Harness()
    key = MasterKeyInfo(id=50, manager_id=1)
    h.core.master_key_used(key)
    h.core.master_key_used(key)
    assert [j["id"] for j in h.jobs if j["kind"] == "master_key_used"] == [50]
    h.now += hub.KEY_USED_EVERY
    h.core.master_key_used(key)
    assert len([j for j in h.jobs if j["kind"] == "master_key_used"]) == 2


def test_a_portfolio_copies_only_from_its_account_and_records_what_it_sent():
    d = make_directory()
    h = Harness(Directory(**{**d.__dict__, "portfolio_logins": {8: 900}}))
    h.v2("OPEN", 1, 0.5, login=901)  # A test account running the same magic
    assert h.payloads("POS", 7) and not h.payloads("POS", 8)
    h.v2("OPEN", 2, 0.5, login=900)
    assert len(h.payloads("POS", 8)) == 1
    trades = [(j["portfolio_id"], j["master_login"], j["pos_id"]) for j in h.jobs if j["kind"] == "portfolio_trade"]
    assert trades == [(7, 901, 1), (7, 900, 2), (8, 900, 2)]
    h.v2("MODIFY", 2, 0.5, sl=1.095, login=900)
    assert len([j for j in h.jobs if j["kind"] == "portfolio_trade"]) == 3  # Recorded once
    assert "901_1" not in h.core.snapshot(8) and "900_2" in h.core.snapshot(8)
