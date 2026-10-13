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
- Pulls queued commands (`poll`) and sends them to the device in its own dialect
  — Teltonika `setdigout` (Codec 12), GT06 `DYD/HFYD` — then `ack`s the result.
- **Safety:** remote immobilise is held if the last known speed shows the vehicle
  moving; it only ever prevents the next start. The server enforces the same.

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
