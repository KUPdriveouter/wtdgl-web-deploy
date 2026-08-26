FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
