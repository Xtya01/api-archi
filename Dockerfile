FROM node:20-slim
WORKDIR /app

# Copy everything
COPY . .

# Install at container start, not during build
CMD sh -c "npm install --omit=dev && node server.js"

EXPOSE 3000
