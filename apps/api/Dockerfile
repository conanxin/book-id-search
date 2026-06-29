FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile=false

COPY apps/api apps/api
RUN pnpm --filter @book-id-search/api build

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
