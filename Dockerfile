FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# قاعدة البيانات والمفاتيح تعيش هنا — اربطها بحجم دائم
# The database and signing key live here: mount a volume so they survive restarts.
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["npm", "start"]
