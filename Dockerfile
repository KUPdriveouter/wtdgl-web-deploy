FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
RUN cat public/Build/WebGLSmoke.data.gz.part-* > public/Build/WebGLSmoke.data.gz \
    && rm public/Build/WebGLSmoke.data.gz.part-*
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
