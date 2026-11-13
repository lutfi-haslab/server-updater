# syntax=docker/dockerfile:1
FROM oven/bun:1-slim

# Set working directory
WORKDIR /app

# Install curl for container healthcheck & clean up apt cache
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy package and TypeScript files
COPY package.json tsconfig.json server.ts ./
COPY src ./src
COPY release.json admin.html ./

# Create default storage directory
RUN mkdir -p /app/binaries

# Default environment configuration
ENV PORT=3001 \
    BINARIES_DIR=/app/binaries \
    RELEASE_FILE=/app/release.json

# Expose update server port
EXPOSE 3001

# Healthcheck for container orchestration
HEALTHCHECK --interval=20s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Start update server
CMD ["bun", "run", "server.ts"]
