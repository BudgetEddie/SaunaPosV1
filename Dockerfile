# =============================================================================
# HOW THE APP BECOMES A CONTAINER.
#
# Two stages. The first builds the React client and is then thrown away, so
# none of its build tools end up in the shipped image. The second builds the
# server and keeps the client's output.
#
# LOCAL-FIRST (2026-08-19): the shipped image now also carries Litestream, the
# tool that streams the SQLite database to the owner's house continuously. It
# rides inside this container rather than beside it so it can supervise the
# server process — see server/docker-entrypoint.sh for the startup sequence
# and for the one behaviour that must be tested before this is trusted.
# =============================================================================

# ---------- Stage 1: build the client ----------
FROM node:22-bookworm-slim AS client-build
WORKDIR /build/client
# Copy the dependency lists first. Docker caches this layer, so a change to
# your own code doesn't force a full reinstall of node_modules every time.
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# Produces /build/client/dist — plain HTML, CSS and JS, no Node needed to serve.
# This runs as a production build, so client/.env.development is ignored and the
# server address comes out empty — meaning "wherever this page came from".
RUN npm run build

# ---------- Stage 2: the server, and the image that actually ships ----------
FROM node:22-bookworm-slim

# OpenSSL. The `slim` base leaves it out, and Prisma probes for it at every
# startup to decide which of its database engines to load. Without it Prisma
# prints a paragraph of warning and then GUESSES — and guesses "openssl-1.1.x",
# which is wrong for Debian bookworm (that's 3.x).
#
# It happens to work anyway here, because SQLite involves no encryption for
# Prisma to get wrong. Installing it regardless, for one reason: this box lives
# in a basement and nobody reads its logs until something IS broken. A warning
# that's always there is a warning nobody sees, and it trains you to skim past
# exactly the place a real problem will appear.
#
# `--no-install-recommends` and deleting the package lists afterwards keep this
# to a couple of megabytes rather than pulling in half a distribution.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
# Note this installs the build tools too, and that is deliberate — `prisma` is
# needed at every startup by the migrate step below. Do NOT "optimise" this with
# `npm prune --production`; the container would then try to fetch prisma from
# the internet every time it starts.
RUN npm ci
COPY server/ ./
# `prisma generate` writes the typed database client from schema.prisma.
# It must run before the TypeScript build, which imports it.
RUN npx prisma generate && npm run build
# The built client lands where index.ts expects it: ../../client/dist relative
# to the compiled server at /app/server/dist.
COPY --from=client-build /build/client/dist /app/client/dist

# ---------- Litestream: continuous backup ----------
#
# Lifted straight out of the official image rather than downloaded from a URL.
# Two reasons that's better than the `ADD https://github.com/...tar.gz` form
# most guides show: the version is pinned to something Docker resolves and
# caches, and there's no release-asset filename to silently 404 the day the
# project renames one.
#
# 0.5.12 (June 2026). Worth knowing the history if you ever change this number:
# 0.5.0 shipped with real bugs, including a restore failure flagged as possible
# data loss, and experienced users publicly advised waiting. Those were fixed
# by 0.5.2 and this is ten releases past that. The older 0.3.x line is still
# maintained too (0.3.14, March 2026) and is the conservative choice if you'd
# rather have boring — but its config file uses the older `replicas:` list
# form, so server/litestream.yml would need changing to match.
COPY --from=litestream/litestream:0.5.16 /usr/local/bin/litestream /usr/local/bin/litestream
COPY server/litestream.yml /etc/litestream.yml

ENV NODE_ENV=production
# Where the live database sits inside the container. Read by the entrypoint,
# and it must agree with the `path:` in litestream.yml — they're the same file
# named in two places, and nothing checks that for you.
ENV LITESTREAM_DB_PATH=/data/prod.db
ENV DATABASE_URL=file:/data/prod.db
EXPOSE 4000

# The startup sequence moved into a script, because it's now three steps that
# have to happen in a particular order and each deserves an explanation. See
# server/docker-entrypoint.sh — restore, then migrate, then replicate-and-run.
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
CMD ["/usr/local/bin/docker-entrypoint.sh"]
