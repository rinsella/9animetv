# Use a small, modern Node base image.
FROM node:20-alpine

WORKDIR /app

# Install only production deps first (better layer caching).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app.
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
