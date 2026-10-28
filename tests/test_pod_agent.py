"""A hosted terminal starting up (pod_agent.py): Wine creates terminal64.exe seconds after the launch."""
import pod_agent


class Launcher:
    """The launched process (start.exe under Wine): alive until killed or until it exits."""

    def __init__(self):
        self.alive, self.killed = True, False

    def poll(self):
        return None if self.alive else 0

    def kill(self):
        self.alive, self.killed = False, True

    def wait(self):
        return 0


def starting(monkeypatch, clock, terminal_pid=None):
    """An agent with one slot launched at clock[0], its terminal64.exe at terminal_pid (None: not there yet)."""
    monkeypatch.setattr(pod_agent.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(pod_agent.Slot, "pid", lambda self: terminal_pid)
    monkeypatch.setattr(pod_agent.Slot, "read_logs", lambda self: None)
    agent = pod_agent.Agent.__new__(pod_agent.Agent)
    agent.next_start = clock[0] + pod_agent.STAGGER_SECONDS
    slot = pod_agent.Slot(4)
    slot.can_start, slot.status, slot.proc, slot.started_at = True, "starting", Launcher(), clock[0]
    agent.slots = {4: slot}
    return agent, slot


def test_a_terminal_wine_has_not_created_yet_is_starting_not_exited(monkeypatch):
    clock = [1000.0]
    agent, slot = starting(monkeypatch, clock)
    clock[0] += 8  # The slowest seen on server2
    agent.supervise()
    assert (slot.status, slot.failures, slot.started_at, slot.retry_at) == ("starting", 0, 1000.0, 0.0)


def test_a_launcher_that_never_brings_its_terminal_up_is_killed_and_retried(monkeypatch):
    clock = [1000.0]
    agent, slot = starting(monkeypatch, clock)
    launcher = slot.proc
    clock[0] += pod_agent.STARTUP_GRACE_S + 1
    agent.supervise()
    assert launcher.killed and slot.proc is None
    assert (slot.status, slot.failures, slot.started_at) == ("restarting", 1, 0.0)
    assert slot.retry_at == clock[0] + pod_agent.BACKOFF_S[0]


def test_a_terminal_that_exits_is_counted_once(monkeypatch):
    clock = [1000.0]
    agent, slot = starting(monkeypatch, clock)
    slot.proc.alive = False  # start.exe exits with its terminal
    clock[0] += 120
    agent.supervise()
    assert (slot.status, slot.failures) == ("restarting", 1)
    clock[0] += 5
    agent.supervise()
    assert slot.failures == 1


def test_a_stable_run_clears_the_failures(monkeypatch):
    clock = [1000.0]
    agent, slot = starting(monkeypatch, clock, terminal_pid=90)
    slot.failures = 3
    clock[0] += pod_agent.STABLE_S - 1
    agent.supervise()
    assert slot.failures == 3
    clock[0] += 2
    agent.supervise()
    assert slot.failures == 0
