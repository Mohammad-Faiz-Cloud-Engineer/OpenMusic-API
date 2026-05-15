FROM node:18-alpine

WORKDIR /app

# Install production dependencies first (layer-cached separately from source)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Run as non-root user (built into node:18-alpine)
USER node

EXPOSE 7860

ENV PORT=7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "src/index.js"]
