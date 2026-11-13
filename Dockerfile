FROM node:18-slim

# ffmpeg for media commands, git for the Update button
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps first (cache layer)
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps || npm install --omit=dev --force

# copy the panel + bot code
COPY . .

# empty session dir; runtime creds are written here by the panel
RUN mkdir -p session data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
