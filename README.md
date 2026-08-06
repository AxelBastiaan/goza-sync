# goza-sync

TypeScript/Express backend for syncing stock between Accurate Online and TikTok Shop (Shopee planned next).

Converted from the original Python prototype — same logic, same signing algorithms, same `.env`-based credential auto-save behavior.

## Setup

```powershell
npm install
```

Copy `.env.example` to `.env` and fill in what you already have from the Python version (App Key, App Secret, Signature Secret, and your existing `ACCESS_TOKEN` / `SHOP_CIPHER` / `ACCURATE_API_TOKEN` / `ACCURATE_HOST` if you want to skip re-authenticating):

```powershell
copy .env.example .env
```

## Running the server (OAuth callback receiver)

```powershell
npm run dev
```

This starts the Express server on `http://127.0.0.1:8000` (or whatever `PORT` you set in `.env`). Same role as `main.py` + `uvicorn` before — pair it with `ngrok http 8000` for local testing against TikTok's sandbox, same as before.

## Running individual scripts

Each of your old standalone `.py` test scripts has a matching npm script:

```powershell
npm run exchange-token       # was exchange_token.py
npm run get-shops            # was get_shops.py
npm run get-products         # was get_products.py
npm run update-inventory     # was update_inventory.py
npm run get-items            # was get_items.py
npm run test-accurate-host   # was test_accurate_host.py
```

All of these auto-save whatever tokens/ciphers/hosts they discover back into `.env`, exactly like the Python versions did.

## Project structure

```
src/
  env.ts                    # .env loader + auto-updater (like update_env() in Python)
  server.ts                 # Express entry point
  routes/
    oauth.ts                # /oauth/callback route (was main.py)
  services/
    tiktokClient.ts         # TikTok signing + callTikTokApi (was tiktok_client.py)
    accurateClient.ts       # Accurate signing + host discovery + callAccurateApi (was accurate_client.py)
  scripts/                  # one-off runnable scripts, same behavior as the old .py files
```

## What's next

- Build the SKU-mapping web UI (a set of Express routes + a simple frontend) so you can pick which SKUs sync instead of hardcoding them
- Add scheduled sync jobs (`node-cron`) for the Accurate → TikTok push direction
- Add the TikTok order webhook handler for the TikTok → Accurate decrement direction
- Add the Shopee client once TikTok + Accurate are fully proven in production
