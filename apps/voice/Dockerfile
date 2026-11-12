FROM node:22.17.0-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
ENV VOICE_HOST=0.0.0.0
EXPOSE 8080
CMD ["pnpm","--filter","@lo/voice","start"]
