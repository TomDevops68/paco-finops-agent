# syntax=docker/dockerfile:1
# Thin wrapper around the upstream LiteLLM proxy image: bakes in this
# repo's model routing config so the image is self-contained (no config
# volume mount needed in Fargate). See docs/adr/0002-litellm-model-gateway.md.

FROM ghcr.io/berriai/litellm:main-stable

COPY config/litellm.yaml /app/config.yaml

EXPOSE 4000
ENTRYPOINT ["litellm"]
CMD ["--config", "/app/config.yaml", "--port", "4000"]
