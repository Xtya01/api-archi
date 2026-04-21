FROM node:20-alpine
WORKDIR /app
COPY package*.json./
RUN npm install --production
COPY..
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]