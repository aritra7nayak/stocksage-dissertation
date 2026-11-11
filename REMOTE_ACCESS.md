# Running on your own PC, reachable from anywhere

The backend stays on this machine — so **FinBERT keeps your GPU** and there is
no cloud capacity queue to wait in. Tailscale Funnel gives it a public HTTPS
URL. Everything here is free.

```
Phone / any browser ──HTTPS──> Tailscale ──encrypted──> your PC
   https://<pc>.<tailnet>.ts.net                        FastAPI :8000
                                                        + React bundle
                                                        + Postgres (Docker)
```

No port forwarding is involved, which matters: most Indian home connections sit
behind CGNAT, where forwarding a router port simply cannot work. Tailscale makes
an outbound connection instead, so it works on any network.

## What you gain and what you give up

**Gain:** GPU FinBERT (roughly 10–20× faster than any free cloud CPU), the full
IST scheduler, no monthly cost, no capacity lottery, and your data never leaves
your machine.

**Give up:** the site is only up **while this PC is awake**. Sleep, shutdown or
an internet drop takes it offline, and the scheduled 08:30 / 12:30 / 16:00 IST
jobs are missed. If you need it reachable at 3 AM from a phone, this is the
wrong choice and a VM is the right one.

---

## One-time setup

### 1. Install Tailscale

Download from [tailscale.com/download/windows](https://tailscale.com/download/windows),
install, and **sign in** (Google or GitHub is fine). This creates your *tailnet*
— a private network containing just your devices, until you publish something.

Confirm it works:

```powershell
tailscale status
```

### 2. Enable MagicDNS and HTTPS certificates

Both live in the [admin console](https://login.tailscale.com/admin/dns) under **DNS**:

- **MagicDNS** → Enable
- **HTTPS Certificates** → Enable

Funnel cannot issue your `https://...ts.net` certificate without these.

### 3. Enable Funnel for this machine

Run it once:

```powershell
tailscale funnel 8000
```

The first time, Tailscale prints a link like
`https://login.tailscale.com/f/funnel?node=...`. Open it and approve — that
grants this one machine permission to publish. Press `Ctrl+C` afterwards;
`start-public.bat` handles it from then on.

### 4. Stop Windows from sleeping

The site dies the moment this PC sleeps. In **Settings → System → Power**:

- **Screen and sleep → When plugged in, put my device to sleep after:** `Never`
- Turning the *screen* off is fine and saves power — only sleep matters.

---

## Daily use

```powershell
start-public.bat              # build frontend, start everything, publish
start-public.bat skipbuild    # same, but reuse the last frontend build (faster)
stop-public.bat               # take it off the internet and shut down
```

`start-public.bat` prints your public URL at the end. It is stable — the same
URL every time, so you can bookmark it on your phone.

`stop-public.bat` closes the tunnel. The URL immediately stops resolving to
anything, which is the right way to take the app offline when you're away.

### Why the frontend gets built

In public mode the React bundle is compiled into `backend\static` and served by
FastAPI itself, so the app and its API share one origin. The Vite dev server on
port 3000 is not involved — it would need its own tunnel and would break the
API calls. Use plain `start.bat` for local development with hot reload.

---

## Security

The app is genuinely on the public internet, so treat it that way.

- **Registration is closed by default.** The first account can always be
  created, so a fresh install bootstraps normally; after that `/api/auth/register`
  returns 403. To invite someone, set `ALLOW_REGISTRATION=true` in
  `backend\.env`, let them sign up, then remove it.
- **Use a strong password.** It is the only thing between the internet and your
  machine. The app enforces a 6-character minimum, which is not enough on a
  public URL — use something long.
- **Set `AUTH_SECRET`** in `backend\.env`. Without it a random secret is
  generated and persisted to `backend\.auth_secret`; setting it explicitly means
  sessions survive predictably.
- **Only port 8000 is published.** Postgres stays on localhost:5433 and is not
  reachable from outside. Nothing else on your PC is exposed.
- **Take it down when you don't need it.** `stop-public.bat` is one click, and an
  offline URL cannot be attacked.

---

## Auto-start when Windows boots (optional)

So a reboot doesn't silently take the app offline:

1. Open **Task Scheduler** → **Create Task**
2. **General:** name it `StockSage Public`, tick **Run whether user is logged on or not**
3. **Triggers:** New → **At startup** → add a 2-minute delay so Docker is up first
4. **Actions:** New → Start a program →
   `C:\Users\aritr\stocksage-india\start-public.bat`
5. **Conditions:** untick *Start the task only if the computer is on AC power*
   if it's a laptop you use unplugged

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `funnel: not permitted` | Step 3 — open the approval link Tailscale printed |
| No certificate / TLS errors | Step 2 — MagicDNS and HTTPS Certificates must both be on |
| URL loads on your PC but not your phone | Turn Wi-Fi off on the phone; if it then works, your router is hairpinning oddly — the public URL is fine |
| Site dies overnight | Windows slept. Step 4 |
| `403 Registration is closed` | Expected. Set `ALLOW_REGISTRATION=true` in `backend\.env` to invite someone |
| Frontend looks stale | You used `skipbuild`. Run `start-public.bat` with no arguments |
| Port 8000 already in use | `start-public.bat` clears it automatically; if it persists, reboot |

## If you outgrow this

The tradeoff that bites is availability — your PC has to be on. When that starts
to hurt, [DEPLOY.md](DEPLOY.md) covers moving to an always-on VM. The code is
identical either way; only where it runs changes.
