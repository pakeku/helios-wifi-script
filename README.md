# Helios Hannover Wi-Fi Checker

Watches the **Helios-Hannover-AP** network from a Windows PC and emails support when it goes down, then again when it comes back.

The checker looks for the access point by name. It does not join the network and it does not test internet access.

## Access point

| Setting | Value |
| --- | --- |
| Operation mode | Access Point |
| Wireless channel | Auto |
| SSID | Helios-Hannover-AP |
| Security | WPA2-PSK |

## How a check works

Each check runs `netsh wlan show networks` and looks for `Helios-Hannover-AP`.

- The network is up when that SSID is in the scan.
- The first time it is missing, the miss is queued. No email is sent yet.
- If the next check misses it too, one email goes out. That email includes the last time the SSID was seen.
- While it stays down, later checks do not send another email.
- The first check that sees the SSID again sends one email to say it is back online.
- A scan that cannot run (Location services off, no Wi-Fi adapter, `netsh` failed) is logged and is not counted as the access point being down.

Times in the emails are shown in Europe/Berlin. The last-up time is saved in `data/wifi-state.json`, so it survives a restart.

## Requirements

- Windows with a Wi-Fi adapter
- Node.js 20 or newer
- Location services turned on (Windows Settings, Privacy & security, Location). Without this, Windows blocks the scan.
- A [Resend](https://resend.com) API key that is allowed to send email
- `systems.helios-instruments.com` verified as a sending domain in that Resend account

## Setup

```bash
npm install
copy env-sample .env
```

Fill in `.env`:

```
RESEND_KEY=re_your_key
EMAIL_FROM=Helios-Hannover-AP@systems.helios-instruments.com
EMAIL_TO=support@heliosinstruments.zendesk.com
```

`EMAIL_FROM` has to be an address on a domain verified in Resend. `EMAIL_TO` is optional. If you leave it out, mail goes to `support@heliosinstruments.zendesk.com`.

## Run

Pass how many minutes to wait between checks. Use a whole number from 1 to 10.

```bash
npm run check-wifi 1
```

That checks immediately, then again every minute, until you stop it with Ctrl+C. `npm run check-wifi 5` waits five minutes between checks.

Each check prints a colored status: green for up or back online, yellow when a miss is queued or a scan cannot run, and red when the SSID is down.

The down email is sent only after two misses in a row, so a one-minute interval reports an outage after about a minute. A ten-minute interval waits ten minutes before the confirming check.

## Emails

Both messages are sent with Resend.

**Down** — subject `Helios-Hannover-AP is down`

The body says the SSID failed two checks in a row, the last time it was seen up, the time of this check, and the interval.

**Back online** — subject `Helios-Hannover-AP is back online`

The body says the network has come back online, when it returned, and when it was last up before the outage.

If Resend rejects a send, the script keeps the alert pending and tries again on the next check.
