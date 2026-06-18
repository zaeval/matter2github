FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--use-system-ca

COPY package.json ./
COPY src ./src
COPY README.md deploy.md ./

RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "src/server.js"]
