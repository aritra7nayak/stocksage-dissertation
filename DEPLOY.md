# Deploying StockSage India — free, public, always on

Runs on an **Oracle Cloud Always Free** ARM VM: 4 vCPU / 24 GB RAM, never
sleeps, no hourly charge and no expiry. Oracle requires a card to verify your
identity, but Always Free resources stay free.

Because the VM is always on, this keeps **everything**: FinBERT sentiment on
CPU, and the real 08:30 / 12:30 / 16:00 IST scheduler running in-process.

```
Internet ──HTTPS──> Caddy ──> app (FastAPI + React bundle) ──> Neon Postgres
                     :443        :7860 (internal)               (managed, TLS)
```

Only Caddy is exposed to the internet, and it obtains and renews a real
Let's Encrypt certificate on its own — no certbot, no manual renewal.

**Two database choices:**

| File | Database | Use when |
|---|---|---|
| `deploy/docker-compose.neon.yml` | Neon (managed) | **Default.** Data survives losing the VM. |
| `deploy/docker-compose.prod.yml` | Postgres container on the VM | You want everything self-contained, with no 0.5 GB cap. |

This guide follows the Neon path.

> **Why not Hugging Face Spaces?** Since July 2026 free accounts get Static
> Spaces only — hosting Gradio and Docker Spaces on free cpu-basic now requires
> a PRO subscription. Render's free tier is card-free but caps at 512 MB, which
> cannot load FinBERT, and its free Postgres expires after 30 days.

---

## Step 0 — The database (do this once)

1. Create a project at [neon.tech](https://neon.tech) and copy the connection
   string.
2. In Neon's **SQL Editor**, paste and run the whole of `database/deploy.sql`.
3. Seed the universe from your laptop:
   ```powershell
   backend\.venv\Scripts\activate
   $env:DATABASE_URL_SYNC = "postgresql://...your Neon string..."
   python scripts\seed_universe.py
   ```

Keep the connection string; you need it in Step 6.

## Step 1 — Push this branch to GitHub

The VM clones from GitHub, so the branch has to be there first. This does not
touch `main`:

```powershell
git push -u origin feat/free-hosting
```

## Step 2 — Create the Oracle account

1. Go to **cloud.oracle.com** and choose *Start for free*.
2. Pick **India (Mumbai)** or **India (Hyderabad)** as your home region. You
   cannot change this later, and Always Free capacity is per-region.
3. Verify with a card. You land on a trial with credits — when it ends, your
   Always Free resources keep running.

## Step 3 — Create the ARM VM

**Compute → Instances → Create instance**

| Setting | Value |
|---|---|
| Image | Canonical **Ubuntu 24.04** |
| Shape | **VM.Standard.A1.Flex** (Ampere ARM) |
| OCPUs | 4 |
| Memory | 24 GB |
| Boot volume | 50 GB is plenty |
| SSH keys | **Save the private key** — it is your only way in |

Confirm it says **Always Free eligible** before creating.

> **If you get "Out of host capacity":** this is the most common frustration
> with Oracle's free ARM tier, and it is not something you did wrong. Try a
> different Availability Domain in the dropdown, then retry periodically.
> Do not upgrade to paid to get around it.

Note the **public IP address** once it boots.

## Step 4 — Open ports 80 and 443

Oracle blocks these in **two** places. Do both, or the site simply times out
with nothing in any log to explain it.

**a) Cloud firewall.** Instance → *Virtual Cloud Network* → *Security Lists* →
default list → **Add Ingress Rules**, twice:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**b) The VM's own iptables.** Ubuntu images on Oracle block everything but SSH:

```bash
ssh -i your-key.key ubuntu@<PUBLIC_IP>

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## Step 5 — Point a free domain at the VM

Caddy needs a real domain to issue a certificate; a bare IP cannot get one.

1. At **duckdns.org**, sign in and create a subdomain, e.g. `stocksage-india`.
2. Set its IP to your VM's public IP and click **update**.

Your app will live at `https://stocksage-india.duckdns.org`.

## Step 6 — Install Docker, clone, configure

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

git clone https://github.com/aritra7nayak/StockSage.git
cd StockSage
git checkout feat/free-hosting

cp deploy/.env.example deploy/.env
openssl rand -hex 32          # copy this for AUTH_SECRET
nano deploy/.env
```

Fill in four values:

```ini
DOMAIN=stocksage-india.duckdns.org
AUTH_SECRET=<the 32-byte value you just generated>
DATABASE_URL=postgresql+asyncpg://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_SYNC=postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
```

The two database lines are your Neon string, identical except for the
`+asyncpg` prefix on the first. `sslmode` is stripped automatically and
translated into a real TLS connection — asyncpg rejects it as a parameter.

`AUTH_SECRET` matters: without it the app generates a throwaway secret at boot,
so every restart logs everyone out.

## Step 7 — Build and start

```bash
cd deploy
docker compose -f docker-compose.neon.yml up -d --build
```

First build takes **15–25 minutes** (torch, FinBERT, and the React bundle).
Follow it with:

```bash
docker compose -f docker-compose.neon.yml logs -f
```

## Step 8 — Open it

Go to **https://stocksage-india.duckdns.org**. Register a username and
password — that first account gets its own paper portfolio automatically. The
scheduler is live, so tomorrow's 08:30 IST brief runs by itself.

---

## Running it day to day

```bash
cd ~/StockSage/deploy
C="-f docker-compose.neon.yml"

docker compose $C ps                    # what's running
docker compose $C logs -f app           # follow app logs
docker compose $C restart app           # restart just the API
docker compose $C down                  # stop everything

git pull && docker compose $C up -d --build     # deploy new code
```

Neon keeps its own backups. If you switch to the VM-hosted Postgres
(`docker-compose.prod.yml`), back it up yourself:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U stocksage stocksage > ~/backup-$(date +%F).sql
```

## Things worth knowing

- **Yahoo Finance rate limits.** `yfinance` is stricter with datacenter IPs than
  with home broadband. The engine skips failed fetches rather than crashing, but
  a cloud run may cover fewer symbols than the same run on your laptop. This is
  the most likely thing to disappoint you, and no host avoids it.
- **Neon free tier** is 0.5 GB and autosuspends after ~5 minutes idle, waking on
  the next query. `pool_pre_ping` and a 300s `pool_recycle` handle the
  reconnect. `market_snapshots` and `stock_analysis` grow daily — prune old rows
  if you approach the cap.
- **DuckDNS is not yours.** Fine for personal use, but if you want a domain
  nobody else controls, buy one and point its A record at the same IP; Caddy
  re-issues the certificate on restart.
- **Oracle reclaims genuinely idle VMs.** Running this stack with daily
  scheduled jobs is normally enough activity to avoid it.
- **You own the patching.** Run `sudo apt update && sudo apt upgrade`
  occasionally, since this is your VM rather than a managed platform.
- **CPU FinBERT** is slower than your GPU — fine for a few hundred headlines a
  day, but backtests will not be instant.

## If something breaks

| Symptom | Cause |
|---|---|
| Site times out | Ingress rules or iptables — Step 4, **both** halves |
| Caddy cert errors in logs | DuckDNS IP doesn't match the VM, or port 80 is closed |
| App restarts in a loop | `logs app` — usually a malformed `DATABASE_URL` |
| `unexpected keyword argument 'sslmode'` | `DATABASE_URL` is missing the `+asyncpg` prefix |
| Login works, then 401 everywhere | `AUTH_SECRET` unset or changed |
