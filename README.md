# Kaitori Discord Bot

Dashboard theo doi gia thu mua iPhone 18, so sanh voi gia goc Apple Japan, sap xep tien lai tu cao xuong thap va tu dong cap nhat moi 30 giay.

## Chuc nang

- Web dashboard tai `http://localhost:3000`
- Lay nhieu san pham iPhone 18 tu cac trang kaitori trong `sources.json`
- So sanh `gia thu mua - gia Apple`
- Sap xep profit tu cao den thap
- Local luu du lieu vao `data/prices.json`; production can Upstash Redis de luu gia ben vung
- Gui Discord webhook khi gia thu mua hoac profit thay doi
- Local cron mac dinh: `*/1 * * * *`
- Vercel Cron goi `/api/cron/check-prices` moi phut theo `vercel.json`

## Cai dat

```bash
npm install
npm start
```

Neu PowerShell chan `npm.ps1`, dung:

```bash
npm.cmd install
npm.cmd start
```

## Discord webhook

Tao file `.env` tu `.env.example`:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PORT=3000
CHECK_CRON=*/1 * * * *
ENABLE_INTERNAL_CRON=true
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
STATE_KEY=kaitori:prices
CRON_SECRET=
```

Khong co `DISCORD_WEBHOOK_URL` thi dashboard van chay, chi khong gui thong bao Discord.

## Deploy Vercel

Tren Vercel, khong nen dung `node-cron` va khong the ghi gia vao file JSON vi serverless filesystem read-only/khong ben. App nay da co endpoint `GET /api/cron/check-prices` va `vercel.json` de Vercel Cron goi moi phut.

Upstash Redis la bat buoc neu muon gia cap nhat dung va ben vung tren production. Neu thieu Redis, app chi giu gia moi trong memory tam thoi cua mot server instance va co the mat khi Vercel cold start.

Set environment variables tren Vercel:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
STATE_KEY=kaitori:prices
ENABLE_INTERNAL_CRON=false
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Neu dat `CRON_SECRET`, goi cron thu cong can header `Authorization: Bearer <secret>` hoac query `?token=<secret>`. Luu y: Vercel Cron mac dinh khong gan custom Authorization header, nen chi bat `CRON_SECRET` neu ban dung cron ben ngoai hoac them token vao path cron.

Khi mot nguon loi tam thoi, app giu gia cu cua nguon do va gan co `stale` de dashboard hien "Gia cu - nguon dang loi" thay vi xoa bang gia.

## Cau hinh nguon gia

Sua `sources.json`.

Nguon Apple co the de dang manual:

```json
{
  "id": "apple-iphone18-manual",
  "shop": "Apple Japan",
  "type": "manual",
  "as": "apple",
  "enabled": true,
  "products": [
    { "model": "iPhone 18 Pro Max", "storage": "256GB", "price": 189800 }
  ]
}
```

Nguon thu mua:

```json
{
  "id": "pastec-iphone18-pro-max",
  "shop": "Mobaste/Pastec",
  "type": "buyback",
  "enabled": true,
  "url": "https://pastec.net/iphone?series_child_id=644"
}
```

Parser se tim cac dong co dang `iPhone18 Pro Max 256GB` va gia yen gan do. Cac trang render bang JavaScript/SPA co the can thay URL index bang API URL neu HTML khong co du lieu san pham.

## API

- `GET /api/prices`: du lieu bang profit moi nhat
- `GET /api/sources`: cau hinh nguon
- `POST /api/check`: kiem tra ngay
- `GET /api/cron/check-prices`: endpoint cho Vercel Cron/cron ben ngoai

## Luu y

Gia Apple trong `sources.json` dang la bang cau hinh manual de tranh loi do Apple Shop render theo JavaScript/region. Khi Apple thay gia, cap nhat block `apple-iphone18-manual`.
