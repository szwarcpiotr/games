# syntax=docker/dockerfile:1

FROM node:22-slim

WORKDIR /app

# Skopiuj pliki manifestu i zainstaluj zależności produkcyjne
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Skopiuj resztę kodu aplikacji
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]