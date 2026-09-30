import json
import logging

import observability


def test_json_log_line_carries_extra_fields():
    record = logging.LogRecord("hub", logging.WARNING, __file__, 1, "Rejected %s", ("900_1",), None)
    record.manager_id = 7
    entry = json.loads(observability.JsonFormatter("hub").format(record))
    assert entry["msg"] == "Rejected 900_1" and entry["level"] == "WARNING"
    assert entry["service"] == "hub" and entry["manager_id"] == 7
