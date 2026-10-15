# IMMOSTOP tracker gateway

A small TCP server that bridges GPS trackers to the IMMOSTOP backend.

GT06/Concox and Teltonika **FMB920 / FMC920** devices speak binary TCP, not
HTTPS, so they can't talk to Supabase directly. This gateway sits in the middle:

```
tracker (SIM, binary TCP) ─▶ gateway (this, public IP) ─▶ HTTPS ─▶ Supabase `tracker` ─▶ app
                            ◀── immobilise / mobilise commands ──◀
```

- Decodes positions (Teltonika Codec 8 / 8E; GT06 location) and forwards them to
  the `tracker` function's `report`.
- Pulls queued commands (`poll`) and sends them to the device in its own dialect,
  then `ack`s the result — and attaches the device's text reply to the ack:

  | command (from app / IMMOTRACK portal) | Teltonika FMB/FMC (Codec 12) | GT06 / Concox (0x80) |
  |---|---|---|
  | `immobilise` / `mobilise` | `setdigout 1` / `setdigout 0` | `DYD,000000#` / `HFYD,000000#` |
  | `locate_now` (panel open / Locate button) | `getgps` → reply parsed into a position | `WHERE#` → reply parsed |
  | `set_timing` `on=20,off=300` (heartbeat) | `setparam` on-stop & moving Min/Send Periods (home, roaming, unknown) | `TIMER,20,300#` |
  | `live_on` / `live_off` (panel Live toggle) | periods → 5 s / back to the vehicle's timing | `TIMER,5,5#` / `TIMER,on,off#` |
  | `custom` | the text as typed | the text as typed |

  Teltonika period IDs used: moving 10050/10055 (+100 roaming, +200 unknown),
  stopped 10000/10005 (+100/+200). Reporting while parked also needs the device's
  Sleep Mode (param 102) left at 0 or GPS-sleep. Verify against the FMB920
  parameter list if a firmware behaves differently.
- **Safety:** remote immobilise is held if the last known speed shows the vehicle
  moving; it only ever prevents the next start. The server enforces the same.

## Updating a running gateway

```bash
cd /opt/immostop-gateway && git pull && npm test && sudo systemctl restart immostop-gw
journalctl -u immostop-gw -f     # watch logins, reports and "command sent" lines
```

## Run it

Needs Node 18+ and a host with a **public, static IP** and two open TCP ports
(so the SIMs can reach it). A ~£4–5/month VPS is plenty.

```bash
cp .env.example .env     # fill in SUPABASE_URL, SUPABASE_ANON_KEY, TRACKER_GATEWAY_KEY
npm test                 # protocol decoders (no network needed)
npm start
```

Keep it running with systemd (example `/etc/systemd/system/immostop-gw.service`):

```ini
[Unit]
Description=IMMOSTOP tracker gateway
After=network.target
[Service]
WorkingDirectory=/opt/immostop-gateway
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=/opt/immostop-gateway/.env
Restart=always
[Install]
WantedBy=multi-user.target
```

Open the firewall for the two ports, e.g. `ufw allow 5023,5027/tcp`.

## One-time Supabase step

Set the matching gateway key as a function secret (dashboard → Edge Functions →
Secrets), so the `tracker` function trusts this gateway:

```
TRACKER_GATEWAY_KEY = <the same value as in .env>
```

Without it set, the function rejects gateway writes (fails safe).

## Point each tracker at the gateway

Set the device's **server IP/domain and port**, and its **APN** (use an IoT data
SIM; the APN is the SIM provider's, e.g. `iot.1nce.net`).

- **Teltonika FMB920/FMC920** — via Teltonika Configurator (USB) or SMS:
  `setparam 2004:<gateway-ip>;2005:5027` (domain/port) and the APN in `2001`.
  Wire **DOUT1** to the immobiliser relay and set the digital-output scenario.
- **GT06** — by SMS to the tracker's number:
  `SERVER,1,<gateway-ip>,5023,0#` and `APN,<apn>#`.
  Wire the relay output to the immobiliser circuit.

## Binding a tracker to a vehicle

The installer does this in the app (Installer tab → Add tracker): scan/enter the
**IMEI**, which binds it to the connected vehicle. From then on the owner sees it
on the map and can immobilise (while stationary). No per-device secret is needed
for gateway-fronted devices — the gateway authenticates them by their protocol
handshake and writes with `TRACKER_GATEWAY_KEY`.

> The tracker add-on is sold as a **subscription** (SIM data + hosting are
> recurring); the app gates the map/commands on an active subscription.
