FROM node:20-slim
WORKDIR /app

# Copy ALL files first (no cache key issues)
COPY . .

# Install after copy
RUN npm install --omit=dev

EXPOSE 3000
HEALTHCHECK --interval=30s CMD node -e "http.get('http://localhost:3000/health',r=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
