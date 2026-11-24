FROM node:22-alpine
WORKDIR /app
# No dependencies, so there is no install layer and nothing to cache.
COPY package.json ./
COPY shared ./shared
COPY services ./services
USER node
EXPOSE 4000 4001 4002
CMD ["node", "-e", "console.log('specify a service via compose command')"]
