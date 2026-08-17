# =============================================================================
# HOW THE APP BECOMES A CONTAINER.
#
# Two stages. The first builds the React client and is then thrown away, so
# none of its build tools end up in the shipped image. The second builds the
# server and keeps the client's output.
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

ENV NODE_ENV=production
EXPOSE 4000

# On every start: bring the database schema up to date, then run the server.
# `migrate deploy` only applies migrations that already exist — unlike
# `migrate dev`, it never invents one or prompts, which is what you want on a
# machine nobody is watching.
#
# `exec` on the last command matters: it replaces the shell with node, so node
# becomes the container's main process and hears "please stop" when Docker
# restarts it. Without it the shell hears the signal, node never does, and every
# restart is a hard kill after a timeout.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/index.js"]
