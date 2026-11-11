# Giving StockSage to someone else as a standalone app

This folder turns the project into **two files on a USB drive**. On the other
Windows PC they go into one folder, the `.bat` gets double-clicked, and a
**StockSage** icon appears on the Desktop. That person then runs the whole
thing — app, database, their own login, their own portfolio — entirely on
their machine. Nothing is shared with your install, and nothing is uploaded.

```
your PC                                    their PC
──────────────────────────────────         ──────────────────────────────
packaging\build-bundle.bat                 Install-StockSage.bat
  ├─ builds stocksage-app:1.0    ══USB══>    ├─ loads both images
  └─ builds stocksage-db:1.0                 ├─ creates their own database
       ↓                                     ├─ seeds the NSE universe
  dist\stocksage-bundle.tar(.gz)             └─ Desktop icon + Start menu
  dist\Install-StockSage.bat
```

They need **Docker Desktop** (free) and nothing else — no Python, no Node, no
repo, no Postgres install. The installer checks for Docker and opens the
download page if it is missing.

---

## 1. Build the bundle (on your PC, once per release)

```bat
packaging\build-bundle.bat
```

First run takes 20–40 minutes — it is building torch, FinBERT and the React
bundle into the image. Later runs are only the save + compress step.

It leaves exactly what you need to copy in `dist\`:

| File | What it is |
|---|---|
| `Install-StockSage.bat` | The installer. ~24 KB, self-contained. |
| `stocksage-bundle.tar` or `.tar.gz` | Both images — the app (FastAPI + React + FinBERT) and Postgres with the schema already baked in. A few GB. |

Copy **both** onto the drive. They must end up in the same folder on the other
PC; the installer looks for the bundle beside itself.

> The `.gz` is kept only if compression actually saves space. Recent Docker
> already stores layers compressed, so the plain `.tar` is often the smaller
> honest answer. Either name works.

## 1b. Try it here first (optional, recommended)

Run `dist\Install-StockSage.bat` on your own machine before handing the drive
over — it is the only way to know the bundle is complete. It is deliberately
safe to do: everything it creates is named `stocksage_desktop_*`, so it cannot
touch the `stocksage_db` container or `pgdata` volume that `start.bat` and
`docker-compose.yml` use, and if your dev backend already holds port 8000 the
installer just picks the next free one. Undo it afterwards from
Start menu → StockSage → Uninstall StockSage.

## 2. Install (on their PC, once)

Double-click **`Install-StockSage.bat`**. It walks through nine steps and is
safe to re-run:

1. finds the bundle
2. checks Docker Desktop is installed and starts its engine
3. detects an existing install (offers to keep the database)
4. picks a free port — 8000 unless something already has it — and generates a
   random database password and login secret
5. loads the two images
6. starts Postgres on a private Docker network with its own data volume, and
   applies the schema on first boot
7. starts the app on `127.0.0.1:<port>` — loopback only, so it is not exposed
   to their network
8. seeds the NSE stock universe
9. writes `%LOCALAPPDATA%\StockSage` and creates the Desktop / Start menu
   shortcuts, then opens the browser

On the first screen they register a username and password. The first account
created is the owner and gets its own paper portfolio.

## 3. Day to day (them)

| | |
|---|---|
| Open | Desktop icon **StockSage** (starts Docker if needed, then opens the browser) |
| Stop | Start menu → StockSage → **Stop StockSage** |
| Uninstall | Start menu → StockSage → **Uninstall StockSage** (asks before deleting data) |
| Notes | `%LOCALAPPDATA%\StockSage\README.txt` |

Containers are created with `--restart no`, so the app only runs when they ask
for it. To make it come back automatically after a reboot instead:

```bat
docker update --restart unless-stopped stocksage_desktop_app stocksage_desktop_db
```

## 4. Shipping an update later

Rebuild, copy the two files over, and let them run the installer again. Step 3
recognises the existing install and keeps the database — `config.json` holds
the original password and auth secret, which is why a reinstall does not lock
them out or lose their portfolio.

Schema changes are the exception: `/docker-entrypoint-initdb.d` runs **only**
on an empty data volume, so a new table added after they installed will not
appear by itself. Ship that as a one-off:

```bat
docker exec -i stocksage_desktop_db psql -U stocksage -d stocksage < your-migration.sql
```

## What is inside, and why

- **`Dockerfile.db`** — `postgres:16-alpine` with `database/deploy.sql` copied
  into `/docker-entrypoint-initdb.d`. The server stacks bind-mount that file
  from the repo; here there is no repo on the target machine, so the schema
  has to travel inside the image.
- **`Install-StockSage.bat`** — a batch wrapper with the real PowerShell
  installer stored after a `#PSPAYLOAD` marker. `cmd` stops reading at
  `exit /b`, so those lines are inert data to it; the wrapper carves them out
  to a temp file and runs them. That is what keeps the delivery at two files
  while still having a proper installer, including the embedded app icon.
  Edit it directly - everything after `#PSPAYLOAD` is ordinary PowerShell, and
  the only opaque part is the one-line base64 of the Desktop icon.
- **`build-bundle.bat`** — builds both images for `linux/amd64` and
  `docker save`s them into one archive.
- **Names** — containers, volumes and the network are all `stocksage_desktop_*`
  rather than the `stocksage_db` / `pgdata` the dev compose file uses, so the
  installer's cleanup step can never remove your development database.

Two things the installer fixes up that the server stacks also need eventually:

- `/app/job_history` does not exist in the image, so Docker creates the mount
  point as `root` while the app runs as uid 1000. The installer `chown`s it, or
  saved multi-backtest runs fail to write.
- `scripts/` used to be in `.dockerignore` while the `Dockerfile` did
  `COPY scripts ./scripts`. It is no longer ignored — the installer seeds the
  universe by running that script inside the container.

## If something goes wrong on their PC

```bat
docker ps -a                              :: is anything running
docker logs stocksage_desktop_app         :: app errors
docker logs stocksage_desktop_db          :: database errors
docker exec stocksage_desktop_app python scripts/seed_universe.py   :: re-seed
```

The most common causes, in order: Docker Desktop not finished starting (its
tray icon must say *Engine running*); WSL2 not enabled on an older Windows
build — Docker Desktop's own installer prompts for this and a reboot; the
bundle copied off the drive while still being written, which shows up as
"was not in the bundle" at step 5.

Prices come from Yahoo Finance at the moment they are used, so that PC needs
internet for fresh data. The scheduler's 08:30 / 12:30 / 16:00 IST jobs only
fire while the app is actually running — after a day with the PC off, they
should trigger a run from inside the app.
