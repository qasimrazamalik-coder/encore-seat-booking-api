FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3003
USER node
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
