# IMMOTRACK gateway

The TCP server that connects GPS trackers to the IMMOTRACK platform.

GT06/Concox and Teltonika **FMB920 / FMC920** trackers speak binary TCP over
their SIM, not HTTPS, so they can't reach the tracker API directly. This gateway
sits on a small always-on server with a public IP:

```
tracker (SIM, binary TCP) ─▶ gateway (this) ─▶ HTTPS ─▶ tracker API ─▶ IMMOTRACK portal / app
                            ◀── commands: immobilise, heartbeat, live, locate ──◀
```

## Install on a fresh Ubuntu VPS (one command)

Rent the smallest Ubuntu 22.04/24.04 box from any provider (Hetzner, DigitalOcean,
Vultr…), note its public IP, connect with `ssh root@THE.IP`, then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/autosecureshop-eng/immotrack-gateway/main/install.sh | sudo bash
```

It installs Node 20, clones this repo to `/opt/immotrack`, runs the tests, writes
`.env` with a freshly generated gateway key, installs a systemd service, opens
ports 22/5023/5027, and prints:

- the **gateway key** — add it in Supabase → Edge Functions → Secrets as
  `TRACKER_GATEWAY_KEY` (the tracker API refuses gateway writes until this matches);
- the **gateway host IP** — enter it in the IMMOTRACK portal → Settings, with the
  SIM APN, so installers know what to program into each device.

**Update later:** re-run the same command (it pulls, tests, restarts), or
`cd /opt/immotrack && git pull && npm test && systemctl restart immotrack-gw`.
Watch it: `journalctl -u immotrack-gw -f`.

## What it does

- Decodes positions (Teltonika Codec 8 / 8E; GT06 location + status) and posts
  them to the tracker API's `report`.
- Pulls queued commands (`poll`), sends them in the device's own dialect, and
  attaches the device's text reply to the command's `ack`:

| command (from portal / app) | Teltonika FMB/FMC (Codec 12) | GT06 / Concox (0x80) |
|---|---|---|
| `immobilise` / `mobilise` | `setdigout 1` / `setdigout 0` | `DYD,000000#` / `HFYD,000000#` |
| `locate_now` (panel open / Locate) | `getgps` → reply parsed into a position | `WHERE#` → reply parsed |
| `set_timing` `on=20,off=300` (heartbeat) | `setparam` moving & stopped Min/Send periods (home, roaming, unknown) | `TIMER,20,300#` |
| `live_on` / `live_off` (Live toggle) | periods → 5 s / back to the vehicle's timing | `TIMER,5,5#` / `TIMER,on,off#` |
| `clear_cache` | *not supported* | `BACKUP,0#` |
| `custom` | text as typed | text as typed |

Teltonika period IDs used: moving 10050/10055 (+100 roaming, +200 unknown),
stopped 10000/10005 (+100/+200). Reporting while parked also needs Sleep Mode
(param 102) left at 0 or GPS-sleep. Check a device's reply in the command result
if a firmware behaves differently.

- **`clear_cache`** drops a GT06's blind-spot buffer. A unit that has been out
  of GPRS for a long time replays its cached fixes on reconnect, which arrive at
  the platform as a trail the vehicle drove hours ago; `BACKUP,0#` turns the
  buffer off and discards it. **Destructive** — anything cached and not yet
  uploaded is lost. Teltonika has no equivalent and answers "not supported by
  this device".

- **Safety:** remote immobilise is only sent when a **recent** speed reading
  shows the vehicle slow enough — `src/safety.js`, tested in
  `test/safety.test.js`. Unknown is not stationary and stale is not now, so a
  cut is **held** when there is no reading yet on the connection, or the last
  one is older than `SPEED_FRESH_MS`. The gateway asks the device for a fix at
  the same time, so a retry succeeds seconds later. `mobilise` is never held.

  This matters because `lastSpeed` starts null on every TCP connection: a unit
  reconnecting mid-journey — out of a tunnel, back into signal — has no reading
  at all. The API's check happens when the command is *queued*, so it cannot
  cover a car that drove off afterwards. The gateway is the last guard before
  the relay.

## Point each tracker at the gateway

Set the device's **server IP + port** and the SIM's **APN** (IoT data SIM).

- **Teltonika FMB920/FMC920** — Teltonika Configurator (USB) or SMS:
  `setparam 2004:<gateway-ip>;2005:5027` and the APN in `2001`.
  Wire **DOUT1** to the immobiliser relay.
- **GT06** — SMS to the tracker's SIM:
  `SERVER,1,<gateway-ip>,5023,0#` then `APN,<apn>#`.
  Wire the relay output to the immobiliser circuit.

Then add the tracker in the IMMOTRACK portal (Vehicles → **+**): IMEI, vehicle,
plate, optional board address, and the tracking term sold with the install. No
per-device secret is needed for gateway-fronted devices — the gateway writes
with `TRACKER_GATEWAY_KEY`.

## Configuration (`.env`)

| var | meaning |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | the tracker API project (pre-filled by the installer) |
| `TRACKER_GATEWAY_KEY` | shared secret; must equal the function secret of the same name |
| `TELTONIKA_PORT` / `GT06_PORT` | listeners (default 5027 / 5023) |
| `LIVE_PERIOD_S` | reporting period while Live is on (default 5) |
| `COMMAND_POLL_S` | how often a connected device's command queue is flushed (default 5; `0` disables the timer and reverts to flushing only when the device sends something) |
| `SPEED_FRESH_MS` | how long a speed reading counts as current for the immobilise guard (default 90000) |

`npm test` runs the protocol decoders and the upstream error handling offline
(no network needed).

## Two trackers can share an IMEI

Cheap GT06-family units ship with cloned or recycled IMEIs, so the digits do
**not** identify one physical tracker. Everything the gateway keeps per device
is keyed on **(protocol, imei)** — `gt06:8651…` and `teltonika:8651…` are two
different trackers — and every `report` / `poll` / `ack` carries a `protocol`
field alongside the IMEI.

**The tracker API and the device page need the same key.** The `protocol` field
is additive, so a function that ignores it behaves exactly as before — but
until it keys on the pair, two trackers sharing an IMEI still land on one
vehicle record and one command queue. Until that is done, give each install a
distinct IMEI where you can.

If two units with the same IMEI connect **on the same protocol**, the gateway
cannot tell them apart at all. It logs

```
WARNING gt06:8651… already connected — replacing the earlier session
```

and keeps the newest connection. Treat that line as a fitting error.

## Commands stuck in the queue

A command can only reach a device that is **currently connected**, so the first
question is whether the unit is online — a parked tracker on the default
`off=300` may simply not be talking yet. While it is connected the queue is
flushed every `COMMAND_POLL_S` seconds, so it should not wait for the next
heartbeat.

If a device is plainly online and reporting positions but commands never go:

```bash
journalctl -u immotrack-gw -f
```

- **`[upstream] poll … TRACKER_GATEWAY_KEY …`** — the tracker API is rejecting
  this gateway. `TRACKER_GATEWAY_KEY` in `/opt/immotrack/.env` must equal the
  Edge Function secret of the same name. Nothing can be delivered until it does.
- **`[upstream] … SUPABASE_URL`** — wrong project URL in `.env`.
- **`[upstream] NOT CONFIGURED`** at startup — `.env` is missing values.
- **`command sent: …`** — the gateway did send it; if the vehicle did not
  respond, look at the command's `ack` text in the portal for the device's own
  reply.

A rejected API call used to be invisible: `fetch` does not throw on a 401, so a
wrong key looked exactly like an empty queue. It is now logged on the first
failure, then once a minute with a count, and again when it recovers.
