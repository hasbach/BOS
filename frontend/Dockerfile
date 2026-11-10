FROM node:24-alpine

WORKDIR /srv/frontend

# Dependencies first, so code changes do not reinstall them.
COPY package.json package-lock.json ./
# The cache mount keeps downloaded packages between attempts, so a dropped connection
# does not start the download from zero.
RUN --mount=type=cache,target=/root/.npm     npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["npm", "run", "start"]
