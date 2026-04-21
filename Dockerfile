FROM node:20-slim

WORKDIR /app

# Copy only package.json first for better caching
COPY package.json ./

# Install (no --production flag, use omit)
RUN npm install --omit=dev

# Copy the rest
COPY server.js ./
COPY public ./public

EXPOSE 3000

# Simple healthcheck that doesn't need wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "http.get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER node

CMD ["node", "server.js"]
