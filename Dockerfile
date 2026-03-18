# --- Stage 1: Build Frontend ---
FROM node:18-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy dependencies first for caching
COPY frontend/package*.json ./
RUN npm install

# Copy source and build
COPY frontend/ ./
RUN npm run build


# --- Stage 2: Setup Backend ---
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (needed for some python packages)
RUN apt-get update && apt-get install -y gcc libffi-dev && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Backend Code
COPY *.py ./

# Copy Built Frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Expose Ports
EXPOSE 8000
EXPOSE 5555
EXPOSE 5556
EXPOSE 5557

# Run Server
CMD ["python", "server.py"]
