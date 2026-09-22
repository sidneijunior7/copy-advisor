import pytest

import hub
from hub import Directory, HubCore, ManagerInfo, StrategyInfo

KEY = "master-key-1"
MANAGER = ManagerInfo(id=1, status="active")
STRATEGY = StrategyInfo(id=10, manager_id=1, name="Trend", is_active=True)


def make_directory(manager=MANAGER, strategy=STRATEGY, portfolios=(7, 8)):
    return Directory(
        managers_by_key={KEY: manager},
        strategies_by_magic={(manager.id, 555): strategy},
        strategies_by_id={strategy.id: strategy},
        portfolios_by_strategy={strategy.id: tuple(portfolios)},
        portfolio_by_key={"portfolio-key-7": 7},
        portfolio_ids=tuple(portfolios),
    )


class Harness:
    def __init__(self, directory=None, legacy=True):
        self.now = 1000.0
        self.dir = directory or make_directory()
        self.published = []
        self.web = []
        self.jobs = []
        self.refreshes = 0
        self.core = HubCore(
            directory=lambda: self.dir,
            publish=lambda topic, payload: self.published.append((topic, payload)),
            web=self.web.append,
            persist=self.jobs.append,
            request_refresh=self._refresh,
            legacy_publish=legacy,
            epoch=42,
            clock=lambda: self.now,
        )

    def _refresh(self):
        self.refreshes += 1

    def v2(self, reason, pos_id, vol, type_=0, sl=1.09, tp=1.12, magic=555, login=900):
        self.core.handle_message(f"{KEY}|V2|{login}|{reason}|{pos_id}|{type_}|EURUSD|{vol}|1.10000|{sl}|{tp}|{magic}")

    def sync(self, entries, login=900):
        body = ";".join(f"{p},0,EURUSD,{v},1.10000,1.09,1.12,555" for p, v in entries)
        self.core.handle_message(f"{KEY}|V2SYNC|{login}|{body}")

    def payloads(self, prefix, topic="P_7"):
        return [p for t, p in self.published if t == topic and p.startswith(prefix)]

    def clear(self):
        self.published.clear()
        self.web.clear()
        self.jobs.clear()


def test_open_publishes_state_to_every_portfolio_with_per_topic_seq():
    h = Harness()
    h.v2("OPEN", 123, 0.5)
    assert h.payloads("POS", "P_7") == ["POS|42|1|900_123|0|EURUSD|0.5|1.1|1.09|1.12|555|OPEN"]
    assert h.payloads("POS", "P_8") == ["POS|42|1|900_123|0|EURUSD|0.5|1.1|1.09|1.12|555|OPEN"]
    assert h.payloads("OPEN|") == ["OPEN|123|0|EURUSD|0.5|1.1|1.09|1.12|555"]
    assert h.web[0]["data"]["key"] == "10_900_123"
    assert h.jobs[0]["kind"] == "position" and h.jobs[0]["closed"] is False

    h.v2("MODIFY", 123, 0.5, sl=1.095)
    assert h.payloads("POS")[-1].startswith("POS|42|2|900_123|")
    assert h.payloads("OPEN|") == ["OPEN|123|0|EURUSD|0.5|1.1|1.09|1.12|555"]  # No legacy line for MODIFY


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
    assert h.payloads("CLOSE|") == ["CLOSE|1|0|EURUSD|0.3|1.1|1.09|1.12|555"]
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


def test_sync_creates_missing_positions_without_legacy_lines():
    h = Harness()
    h.sync([(1, 1.0)])
    assert h.payloads("POS")[0].endswith("|SYNC")
    assert h.payloads("OPEN|") == []


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
    assert h.payloads("CLOSE|") == []  # Not a live event


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
    h.core.handle_message(f"{KEY}|V2SYNC|900|")
    assert h.core.stats["errors"] == 0


def test_legacy_master_messages():
    h = Harness()
    h.core.handle_message(f"{KEY}|OPEN|77|0|EURUSD|0.5|1.1|0|0|555")
    h.core.handle_message(f"{KEY}|OPEN|77|0|EURUSD|0.2|1.2|0|0|555")  # Netting scale-in
    h.core.handle_message(f"{KEY}|CLOSE|77|1|EURUSD|0.7|1.3|0|0|555")
    vols = [p.split("|")[6] for p in h.payloads("POS")]
    assert vols == ["0.5", "0.7", "0"]
    assert [p.split("|")[3] for p in h.payloads("POS")] == ["0_77"] * 3


def test_unknown_key_requests_refresh_rate_limited():
    h = Harness()
    h.core.handle_message("nope|V2|1|OPEN|1|0|EURUSD|1|1.1|0|0|555")
    h.core.handle_message("nope|V2|1|OPEN|1|0|EURUSD|1|1.1|0|0|555")
    assert h.published == [] and h.refreshes == 1


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

    h.core.handle_message(f"{KEY}|V2SYNC|950|9,1,GBPUSD,2,1.3,0,0,555")
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


def test_empty_portfolio_gets_empty_snapshot():
    h = Harness(directory=make_directory(portfolios=(7,)))
    h.core.load_positions([])
    h.core.tick()
    assert h.payloads("SNAP") == ["SNAP|42|0|"]


def test_exec_is_persisted():
    h = Harness()
    h.core.handle_message("EXEC|12345|portfolio-key-7|900_1|OPEN|555001|0.5|1.1001|10009|3")
    job = h.jobs[0]
    assert job["kind"] == "execution" and job["portfolio_id"] == 7 and job["retcode"] == 10009


def test_legacy_publish_can_be_disabled():
    h = Harness(legacy=False)
    h.v2("OPEN", 1, 1.0)
    assert h.payloads("OPEN|") == [] and len(h.payloads("POS")) == 1


@pytest.mark.parametrize("value,expected", [(1.1, "1.1"), (130000.0, "130000"), (0.00012345, "0.00012345"), (0.0, "0")])
def test_fmt(value, expected):
    assert hub.fmt(value) == expected
