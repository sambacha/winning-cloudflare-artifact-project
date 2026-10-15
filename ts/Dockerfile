# Image of the Sandbox SDK container (wrangler.toml [[containers]]).
# UNVERIFIED: the base image name/tag must match the installed
# @cloudflare/sandbox version (the SDK documents a matching
# docker.io/cloudflare/sandbox:<version> image). Not built from this
# repository (no Docker, no network).
FROM docker.io/cloudflare/sandbox:latest

# The predicate step needs git (fetch by commit id, checkout), node + npm
# (npm ci / npm test), tar + gzip (node_modules cache), and GNU timeout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar gzip coreutils \
 && rm -rf /var/lib/apt/lists/*

# A non-interactive git identity for the notes writer is passed per command
# (GIT_AUTHOR_* / GIT_COMMITTER_* in src/bisect/notes.ts); nothing to bake in.
WORKDIR /workspace
