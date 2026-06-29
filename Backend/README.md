# ZAYA Backend + Web PWA

This is the free pilot backend for ZAYA.

It does not require paid infrastructure or external packages. It uses:

- Node.js standard library.
- Local JSON database in `Backend/data/zaya-db.json`.
- Browser PWA in `Backend/public`.

## Start

```bash
cd /Users/user/Desktop/ZAYA/Backend
npm start
```

Open:

```text
http://localhost:8787
```

The first registered user becomes `admin`.

## Free Internet Deploy

See the simple step-by-step guide:

```text
/Users/user/Desktop/ZAYA/DEPLOY_FREE_SERVER.md
```

## What Works Now

- User registration and login.
- Personal cabinet from iPhone, Android, and computer browser.
- Device claiming by pairing code.
- Device list and status.
- Free plan with 4 zones.
- Admin grants: Free, Plus, Pro, Founder.
- Admin user list and device list.
- Cloud API endpoints for ESP32 telemetry and command polling.

## API Summary

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`

### User Devices

- `GET /api/devices`
- `POST /api/devices/claim`
- `POST /api/devices/:id/commands`

### ESP32 Cloud Bridge

These endpoints are ready for the next firmware step:

- `POST /api/devices/:id/telemetry`
- `GET /api/devices/:id/commands/pending`
- `POST /api/devices/:id/commands/:commandId/ack`

ESP32 must send:

```text
X-ZAYA-Device-Secret: cloudSecret
```

The `cloudSecret` is returned after claiming the device.

The iOS app sends this local command to ESP32 after a successful backend claim:

```json
{
  "cmd": "cloud_config",
  "api_base_url": "http://192.168.0.10:8787",
  "cloud_device_id": "backend-device-id",
  "cloud_secret": "backend-device-secret"
}
```

ESP32 stores these values in Preferences and then:

- posts telemetry to `/api/devices/:id/telemetry`;
- polls `/api/devices/:id/commands/pending`;
- acknowledges commands at `/api/devices/:id/commands/:commandId/ack`.

For a real phone, `api_base_url` must be the computer/server IP in the same WiFi network, not `localhost`.

### Admin

- `GET /api/admin/users`
- `GET /api/admin/devices`
- `POST /api/admin/users/:id/grant`

## Production Upgrade Path

When the product starts growing, replace the local JSON database with:

- Firebase/Supabase/Postgres for users, devices, subscriptions, grants, and audit logs.
- TLS HTTPS domain.
- MQTT over TLS or AWS IoT Core for remote commands.
- Signed OTA firmware releases.
- Real payment provider only when monetization starts.

The API shape is intentionally close to that future architecture, so this pilot can evolve instead of being thrown away.
