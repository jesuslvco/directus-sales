FROM directus/directus:11

WORKDIR /directus

# Railway binds to PORT dynamically; Directus must listen on all interfaces.
ENV HOST=0.0.0.0
ENV EXTENSIONS_PATH=/directus/extensions

COPY --chown=node:node ./extensions /directus/extensions

EXPOSE 8055
