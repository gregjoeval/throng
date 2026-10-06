FROM node:22-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
# Deploys attempt Previews; pinned to the platform's wrangler.
RUN npm install -g wrangler@4.147.0 && npm cache clean --force
WORKDIR /workspace
CMD ["sleep", "infinity"]
