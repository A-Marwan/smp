# Stremio Mega Proxy (SMP)

Stream your personal movies and TV series stored on [MEGA.nz](https://mega.nz) directly in [Stremio](https://www.stremio.com/).

SMP is a self-hosted Stremio addon that scans your MEGA cloud storage, matches video files to metadata (posters, descriptions, etc.), and serves them as streamable content inside Stremio — with full seeking support.

## Features

- Browse your MEGA library as a Stremio catalog with posters and metadata
- Stream videos with HTTP Range support (seeking/scrubbing works)
- Automatic metadata matching via Cinemeta (IMDb)
- Token-protected endpoints — only you can access your streams
- MFA (two-factor authentication) support for MEGA accounts
- Concurrency limiter to prevent MEGA quota issues
- Runs as a systemd service for always-on access

## Prerequisites

- **Node.js** 20 or later — [download here](https://nodejs.org/)
- A **MEGA.nz** account with video files uploaded
- **Stremio** installed on your device — [download here](https://www.stremio.com/downloads)
- A Linux server (VPS or home server) if you want remote access

## Quick Start

### 1. Clone the repository

```bash
git clone git@github.com:A-Marwan/smp.git
cd smp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your details:

```env
PORT=7000
MEGA_EMAIL=your@email.com
MEGA_PASSWORD=yourpassword
USER_TOKEN=pick-a-long-random-secret
```

> Generate a strong random token: `openssl rand -hex 32`

### 4. Index your library

This scans your MEGA account, parses filenames, and matches them to IMDb entries:

```bash
npm run index
```

This may take a few minutes depending on how many files you have. You'll see logs showing which files were matched and which were skipped.

### 5. Start the server

```bash
npm start
```

The server starts on `http://localhost:7000` (or whatever `PORT` you set).

### 6. Add to Stremio

Open Stremio and go to the addon URL:

```
http://localhost:7000/YOUR_TOKEN/manifest.json
```

Replace `YOUR_TOKEN` with the `USER_TOKEN` you set in `.env`.

That's it — your MEGA movies and series will appear in Stremio.

---

## Configuration Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `7000` | Port the server listens on |
| `MEGA_EMAIL` | **Yes** | — | Your MEGA account email |
| `MEGA_PASSWORD` | **Yes** | — | Your MEGA account password |
| `MEGA_ROOT_FOLDER` | No | *(entire account)* | Name of a specific MEGA folder to scan instead of the whole account |
| `DB_PATH` | No | `data.db` | Path for the SQLite database file |
| `USER_TOKEN` | **Recommended** | — | Secret token to protect all endpoints. Without this, anyone with your URL can stream your files |
| `BASE_URL` | No | `http://localhost:PORT` | Your external URL when behind a reverse proxy (e.g. `https://smp.example.com`) |

## File Naming Conventions

SMP parses your filenames to identify movies and series. Name your files following these patterns for the best results.

### TV Series

The key is the `S01E01` pattern (season and episode numbers):

```
Show.Name.S01E01.720p.mkv          ✓
Show_Name_S1E1_HDTV.avi            ✓
Show Name - S01E01 - Episode.mkv   ✓
Show.Name.S01E01E02.mkv            ✓  (multi-episode)
```

### Movies

Include the year for accurate matching:

```
Movie.Name.2021.1080p.mkv          ✓
Movie Name (2021) [1080p].mkv      ✓
Movie.Name.mkv                     ⚠  (works but may match wrong title)
```

### Tips

- Separators can be dots `.`, underscores `_`, hyphens `-`, or spaces
- The year helps distinguish remakes and same-name movies
- Quality tags (`720p`, `1080p`, etc.) are ignored — put them anywhere after the title
- Files that can't be matched are logged in the `unmatched_files` database table

## Indexing Your Library

### Full index

```bash
npm run index
```

Crawls your MEGA account, parses every video filename, resolves it against Cinemeta, and stores the result in the SQLite database. Run this whenever you add new files to MEGA.

### Scan (debug)

```bash
npm run scan
```

Lists all files in your MEGA account without indexing — useful to check what SMP can see.

## Running the Server

### Production

```bash
npm start
```

### Development (auto-reload on file changes)

```bash
npm run dev
```

## MFA (Two-Factor Authentication)

If your MEGA account has MFA enabled, the server will prompt for a TOTP code on first startup. For headless/service deployments, use the MFA helper script:

1. Start the server (it will wait for the MFA code)
2. In another terminal, run:

```bash
./src/scripts/send-mfa.sh 123456
```

Replace `123456` with your current TOTP code from your authenticator app.

The script reads `USER_TOKEN` and `PORT` from your `.env` file automatically.

## Running as a Systemd Service

This keeps SMP running in the background and auto-restarts it on failure or reboot.

### 1. Edit the service file

The repo includes a template at `smp.service`. Copy it and fill in the real paths:

```bash
sudo cp smp.service /etc/systemd/system/smp.service
sudo nano /etc/systemd/system/smp.service
```

Update the placeholder paths (`...`) to match your setup:

```ini
[Unit]
Description=Stremio MEGA Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/youruser/stremio-mega-proxy
EnvironmentFile=/home/youruser/stremio-mega-proxy/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

> Find your Node.js path with `which node`.

### 2. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable smp
sudo systemctl start smp
```

### 3. Check status and logs

```bash
sudo systemctl status smp
sudo journalctl -u smp -f
```

### Sending MFA to a running service

If MFA is required after the service starts:

```bash
./src/scripts/send-mfa.sh 123456
```

## Reverse Proxy Setup

A reverse proxy gives you HTTPS (required for Stremio Web) and a clean domain name. Set `BASE_URL` in your `.env` to your external URL:

```env
BASE_URL=https://smp.example.com
```

### Option 1: Caddy (Recommended)

[Caddy](https://caddyserver.com/) is the simplest option — it handles HTTPS certificates automatically.

#### Install Caddy

```bash
sudo apt install -y caddy
```

Or see [Caddy install docs](https://caddyserver.com/docs/install) for other methods.

#### Configure

Edit `/etc/caddy/Caddyfile`:

```caddyfile
smp.example.com {
    reverse_proxy localhost:7000
}
```

That's it. Caddy automatically obtains and renews a Let's Encrypt certificate for your domain.

#### Apply

```bash
sudo systemctl reload caddy
```

### Option 2: Nginx

#### Install Nginx and Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

#### Configure

Create `/etc/nginx/sites-available/smp`:

```nginx
server {
    listen 80;
    server_name smp.example.com;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming support
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

#### Enable and get HTTPS

```bash
sudo ln -s /etc/nginx/sites-available/smp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d smp.example.com
```

Certbot will modify the config to add HTTPS and set up auto-renewal.

### DNS

Point your domain (`smp.example.com`) to your server's IP address with an **A record** in your DNS provider.

## Installing the Addon in Stremio

### Desktop / Mobile

1. Open Stremio
2. Click the **puzzle piece** icon (Addons) in the top bar
3. In the search bar at the top, paste your addon URL:
   ```
   https://smp.example.com/YOUR_TOKEN/manifest.json
   ```
4. Click **Install**
5. Go to **Discover** or **Library** — you'll see "MEGA Movies" and "MEGA Series" catalogs

### Stremio Web

1. Go to [Stremio Web](https://web.stremio.com/)
2. Log in with your Stremio account
3. Paste your addon URL in the addon search bar
4. Install — your catalogs will appear

> Stremio Web requires HTTPS, so make sure you've set up a reverse proxy with SSL.

## Troubleshooting

### Files not showing up in Stremio

- Run `npm run index` again after adding new files to MEGA
- Check that filenames follow the [naming conventions](#file-naming-conventions)
- Run `npm run scan` to verify SMP can see your MEGA files
- Check `MEGA_ROOT_FOLDER` if you're limiting the scan to a specific folder

### Video buffering or not playing

- SMP limits concurrent streams to 2 per file to avoid MEGA quota issues
- MEGA free accounts have limited transfer quotas — consider a paid plan for heavy use
- Make sure `proxy_buffering off` is set if using Nginx

### MFA errors

- MEGA sessions expire — re-send the MFA code with `./src/scripts/send-mfa.sh <code>`
- Check `journalctl -u smp -f` for authentication errors

### "Token invalid" or 403 errors

- Verify `USER_TOKEN` in your `.env` matches the token in your Stremio addon URL
- Restart the service after changing `.env`: `sudo systemctl restart smp`

### MEGA quota exceeded (429 errors)

- Wait for your MEGA transfer quota to reset (usually a few hours)
- Free accounts have stricter limits — upgrading helps

## API Reference

All endpoints are prefixed with your `USER_TOKEN` (if set).

| Method | Endpoint | Description |
|---|---|---|
| GET | `/:token/manifest.json` | Stremio addon manifest |
| GET | `/:token/catalog/:type/:id.json` | Browse movie/series catalog |
| GET | `/:token/meta/:type/:id.json` | Get metadata for a title |
| GET | `/:token/stream/:type/:id.json` | Get stream URLs for a title |
| HEAD | `/:token/stream/:handle` | Check file info (size, type) |
| GET | `/:token/stream/:handle` | Stream a video file (supports Range) |
| POST | `/:token/admin/mfa` | Send MFA code `{"code": "123456"}` |

## License

MIT
