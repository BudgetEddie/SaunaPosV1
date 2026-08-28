# Deploying to the shop

How to put a new version of the app on the till at the shop. Written to be followed
top to bottom by someone who hasn't done it before.

The whole thing is about five minutes. Read part 1 before you start.

---

## 1. What you're actually doing, and what can go wrong

Deploying does three things, and they carry very different risk:

| Step | What it changes | Risk |
|---|---|---|
| Rebuild the containers | The app's code | Low — you can rebuild the old version |
| The database migration | The **shape** of tables holding real data | The one that matters |
| Seeding the menu | Adds menu rows | Low — adds only, deletes nothing |

**The migration runs by itself.** You never type a migration command. The container's start
command is `npx prisma migrate deploy && node dist/index.js` (see `Dockerfile`), so bringing the
container up *is* what applies any new migrations. That's deliberate — it means the database
schema can never drift behind the code that's running against it.

**Take a backup first anyway.** Step 2 is thirty seconds and makes everything reversible. The
database holds staff logins, lockers, customers and every bill ever rung up; none of that is in
git and none of it can be recreated.

**Do it when the shop is closed, or at least quiet.** The app is down for a few seconds while
the container restarts, and anyone mid-checkout will get an error.

### Before you start

- You can `ssh` to the shop machine.
- A `.env` file sits next to `docker-compose.prod.yml` on that machine, holding
  `POSTGRES_PASSWORD` and `JWT_SECRET`. If the app is already running, it's there.
  **Don't regenerate `JWT_SECRET`** — it signs the staff sign-in tokens, so changing it
  logs everybody out immediately.
- The changes you want are merged to `main` on GitHub.

Every command below is run **on the shop machine**, from the folder holding
`docker-compose.prod.yml`. `dc` is just a shorthand so the lines don't run off the page:

```bash
alias dc='docker compose -f docker-compose.prod.yml'
```

---

## 2. Back up the database

```bash
dc exec -T db pg_dump -U sauna sauna_pos > ~/backup-$(date +%Y%m%d-%H%M%S).sql
```

The `-T` matters: without it Docker allocates a terminal and the file comes out mangled.

Then **check the file is real** rather than an empty file from a failed command:

```bash
ls -lh ~/backup-*.sql | tail -1
grep -c 'CREATE TABLE' ~/backup-*.sql | tail -1
```

You want a size in kilobytes at least, and a `CREATE TABLE` count in the teens. A 0-byte file
means the dump failed — stop and work out why before going further.

---

## 3. Deploy the new code

```bash
git pull
dc up -d --build
```

`--build` rebuilds the image from the code you just pulled. As the app container starts it
applies any new migrations, then serves the app.

Watch it come up:

```bash
dc logs -f app
```

You're looking for the migrations applying and then the server starting. Press `Ctrl-C` to stop
watching — that stops the log, not the app.

If a migration fails, the container will keep restarting and the log will say why. Postgres
applies schema changes transactionally, so a failed migration rolls back rather than leaving
the database half-changed.

---

## 4. Check it worked

```bash
dc ps
```

Both `db` and `app` should be `running`, and `app` should not be restarting over and over.

Then open the till in a browser (`http://<the shop machine>`) and confirm:

- The sign-in page loads and you can sign in — if everyone is suddenly signed out,
  `JWT_SECRET` changed.
- **Point of Sale** shows the menu.
- **Home** shows the locker counts.
- Any tabs that were open before are still open.

---

## 5. Load the menu — first time only

Only needed on an install whose menu isn't set up yet. Skip it otherwise.

```bash
dc exec app npx ts-node prisma/seed-menu.ts
```

This adds the sections and items in `server/prisma/seed-menu.ts`. It is **safe to re-run**: it
skips anything already there by name, never overwrites a price someone corrected at the till,
and deletes nothing. It prints what it added and what it left alone.

It fills the first active location. To fill a different site:

```bash
dc exec app npx ts-node prisma/seed-menu.ts --location "Toronto"
```

### The other seed scripts

| Script | Safe on a till in use? |
|---|---|
| `prisma/seed-menu.ts` | **Yes.** Adds only. |
| `prisma/seed-users.ts` | **Yes.** Creates or updates staff logins — this is also how you reset a forgotten password. |
| `prisma/seed.ts` | **NO — it erases every visit, bill and kitchen order.** First-time setup only. It refuses to run on a database with visits unless forced, and that refusal is correct. Don't force it. |

---

## 6. If it goes wrong

**The app won't start.** Read the log — `dc logs --tail=50 app`. Most first-time failures are a
missing or wrong `.env`, and the app says so plainly.

**Go back to the previous version.** The code is in git, so roll back to the commit that was
running before and rebuild:

```bash
git log --oneline -5        # find the commit you were on
git checkout <that-commit>
dc up -d --build
```

⚠️ **Rolling the code back does not roll the database back.** Migrations don't un-apply. If a
migration ran and you need the old schema too, restore the backup:

```bash
dc stop app
dc exec -T db psql -U sauna -d postgres -c 'DROP DATABASE sauna_pos;'
dc exec -T db psql -U sauna -d postgres -c 'CREATE DATABASE sauna_pos;'
dc exec -T db psql -U sauna -d sauna_pos < ~/backup-<the-one-you-took>.sql
dc up -d app
```

That returns the database to exactly the moment you took the backup — which is why step 2
exists, and why it's worth checking the file wasn't empty.

---

## 7. Notes worth knowing

**The database is not reachable from the network.** `docker-compose.prod.yml` deliberately gives
the `db` service no `ports:` line, so only the app container can talk to it. That's why every
database command here goes through `dc exec db` rather than connecting directly.

**Development and production never share data.** The prod stack is named `sauna-pos-prod` and
keeps its own storage, so running the dev `docker-compose.yml` on the same machine touches a
completely different database. Menu items, customers and bills created while developing do not
exist on the till, and vice versa. Database *structure* travels through the migration files in
git; database *contents* never travel at all.

**The image ships with its build tools on purpose.** `Dockerfile` installs dev dependencies and
never runs `npm prune --production`, because `prisma` is needed at every startup for the migrate
step. That's also what makes `ts-node` available for the seed commands above.
