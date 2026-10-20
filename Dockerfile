# Same service as the Render web service, for running anywhere: docker build -t covered . && docker run -p 8787:8787 covered
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8787 COVERED_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["npm", "start"]
