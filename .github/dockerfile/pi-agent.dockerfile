FROM node:22-bookworm-slim

ENV PNPM_HOME=/opt/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@9.15.9 --activate \
    && pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent \
    && pi --version \
    && pi install npm:pi-hermes-memory \
    && pi list

RUN mkdir /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

CMD ["pi"]
