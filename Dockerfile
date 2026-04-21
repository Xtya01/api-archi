FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
