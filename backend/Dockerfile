FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY package*.json ./
# Needed before install: package.json's postinstall hook runs scripts/patchMaxPlanNames.js,
# which makes an unknown Max plan name a warning instead of a scrape-killing throw.
COPY scripts/ ./scripts/
RUN npm install --omit=dev
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/index.js"]
