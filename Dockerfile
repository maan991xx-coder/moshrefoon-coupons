FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# قاعدة البيانات والمفاتيح تعيش في /app/data — اربطها بحجم دائم من منصة الاستضافة
# (Railway يرفض كلمة VOLUME في Dockerfile؛ الحجم يُضاف من لوحة المنصة أو من docker-compose).
# The database and signing key live in /app/data: mount a volume from the platform
# (Railway rejects Dockerfile VOLUME; compose and fly.toml mount it themselves).
EXPOSE 3000

CMD ["npm", "start"]
