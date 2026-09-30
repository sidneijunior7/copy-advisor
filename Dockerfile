# API + dashboard (service "mirror-api"). The signal hub is a separate service: see Dockerfile.hub.

# --- Stage 1: Build Frontend ---
FROM node:18-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy dependencies first for caching
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ ./
RUN npm run build


# --- Stage 2: Setup Backend ---
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# Install system dependencies (needed for some python packages)
RUN apt-get update && apt-get install -y gcc libffi-dev && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Backend Code + migrations
COPY *.py alembic.ini ./
COPY alembic/ ./alembic/

# Copy Built Frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

EXPOSE 8000

# Trust X-Forwarded-For from EasyPanel's proxy, so the login/license rate limit sees the real client IP.
# Port 8000 is only reachable through that proxy.
ENV FORWARDED_ALLOW_IPS="*"

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"

# Migrate, then hand PID 1 to uvicorn so it receives SIGTERM
CMD python migrate.py && exec uvicorn server:app --host 0.0.0.0 --port 8000
