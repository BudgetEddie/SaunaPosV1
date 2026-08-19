#!/bin/sh
# =============================================================================
# WHAT HAPPENS EVERY TIME THIS CONTAINER STARTS.
#
# Three steps, in this order, and the order is the whole point:
#
#   1. RESTORE   — if there's no database here but there IS a backup, pull the
#                  backup down first. This is the step that turns "the box died"
#                  into "plug in a new box and it comes back with the data".
#   2. MIGRATE   — bring the database schema up to date.
#   3. REPLICATE — start streaming changes to the backup, and run the app.
#
# Getting 1 before 2 right matters. A fresh box has an empty disk. If it
# migrated first it would build an empty database, and then the restore would
# be skipped because a database now "exists" — quietly starting the business
# from nothing on the day you most needed the backup.
#
# `set -e` stops on the first failure rather than blundering on to the next
# step with a half-built database.
# =============================================================================
set -e

# Litestream 0.5 stopped creating parent directories during restore (it did in
# 0.3). Without this, a first-ever start on an empty volume fails on a missing
# folder rather than doing anything useful.
mkdir -p "$(dirname "$LITESTREAM_DB_PATH")"

# ---------- 1. Restore, but only if it's actually the right thing to do ------
#
# Both flags mean "this is not an error, carry on":
#   -if-db-not-exists   — a database is already here, so don't touch it. This is
#                         the normal case on every restart after the first.
#   -if-replica-exists  — no backup found. Also normal: the very first start at
#                         a brand new site, before anything has been sold.
#
# So this line does nothing at all on an ordinary restart, and does the entire
# disaster recovery on a fresh box. Any OTHER failure — unreadable backup,
# permissions, a corrupt replica — still stops the container, which is what you
# want. Starting empty and pretending everything is fine would be worse.
echo "[entrypoint] checking for a backup to restore..."
litestream restore \
  -if-db-not-exists \
  -if-replica-exists \
  -config /etc/litestream.yml \
  "$LITESTREAM_DB_PATH"

# ---------- 2. Bring the schema up to date -----------------------------------
#
# `migrate deploy`, NOT `migrate dev`. Deploy only applies migrations that
# already exist in prisma/migrations/ — it never invents one and never prompts.
# That's what you want on a machine in a basement that nobody is watching.
echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy

# ---------- 3. Replicate, and run the app ------------------------------------
#
# `-exec` makes Litestream the parent process: it starts the app, streams the
# database to the backup while the app runs, and shuts down when the app exits.
#
# READ THIS BEFORE TRUSTING IT IN A SHOP. The whole reason this architecture
# exists is so the till keeps working when the internet doesn't. That only
# holds if Litestream, on finding its backup destination unreachable, RETRIES
# QUIETLY rather than giving up — because giving up here would take the app
# down with it and stop the business over a failed backup.
#
# Litestream is built for exactly this (its normal home is "replicate to S3
# over a flaky link") and retries with backoff. But it is not something to take
# on trust: pull the network / unmount the backup folder mid-shift and confirm
# the app keeps serving. Until that test has actually been run, treat this
# arrangement as unproven. If it ever does prove to kill the app, the fix is to
# move Litestream into its own container beside this one, where it can fail
# without touching the till.
#
# `exec` replaces this shell with Litestream, so Litestream becomes the
# container's main process and hears "please stop" from Docker directly.
# Without it the shell hears the signal, nothing else does, and every restart
# is a hard kill after a timeout.
echo "[entrypoint] starting replication and the server..."
exec litestream replicate \
  -config /etc/litestream.yml \
  -exec "node dist/index.js"
