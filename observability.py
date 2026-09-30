"""Logging and error reporting shared by the API and the hub.

LOG_FORMAT=json writes one JSON object per line, with any `extra=` fields of the call
(manager_id, uid, portfolio_id...) as top-level keys, so logs can be filtered per manager or signal.
SENTRY_DSN, when set, sends unhandled exceptions and ERROR logs to Sentry.
"""
import json
import logging
import os

# Attributes every LogRecord has: anything else came from `extra=`
_RESERVED = set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}",
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _RESERVED and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


def setup(service: str):
    handler = logging.StreamHandler()
    if os.getenv("LOG_FORMAT", "text").lower() == "json":
        handler.setFormatter(JsonFormatter(service))
    else:
        handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())

    dsn = os.getenv("SENTRY_DSN")
    if dsn:
        import sentry_sdk
        sentry_sdk.init(dsn=dsn, environment=os.getenv("SENTRY_ENVIRONMENT", "production"),
                        server_name=service, send_default_pii=False)
