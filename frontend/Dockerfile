FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
ARG VITE_GOOGLE_CLIENT_ID
# In production nginx proxies /api/ to the backend, so use a relative base URL
ENV VITE_API_URL=/api
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
# Generate all PWA icon sizes from public/icon.svg
RUN npm run generate-pwa-assets
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
