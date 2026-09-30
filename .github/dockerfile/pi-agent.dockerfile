FROM node:22-bookworm-slim

ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates coreutils curl findutils git gnupg grep gzip tar zstd ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@9.15.9 --activate \
    && pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.2 \
    && pi --version \
    && mkdir -p /workspace \
    && chown node:node /workspace

USER node
WORKDIR /workspace

RUN pi install npm:@llblab/pi-telegram@0.51.6 \
    && pi install npm:pi-hermes-memory \
    && pi install npm:pi-web-access \
    && pi list

USER root
RUN pi install npm:@llblab/pi-telegram@0.51.6 \
    && pi install npm:pi-hermes-memory \
    && pi install npm:pi-web-access \
    && pi list

COPY web-search.json /root/.pi/agent/web-search.json
COPY --chown=node:node web-search.json /home/node/.pi/agent/web-search.json
RUN chmod 600 /root/.pi/agent/web-search.json /home/node/.pi/agent/web-search.json

USER node

CMD ["pi"]
