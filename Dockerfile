FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 7860

ENV PORT=7860

CMD ["node", "src/index.js"]
