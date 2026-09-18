# Kaitori Discord Bot

Dashboard theo doi gia thu mua iPhone 18, so sanh voi gia goc Apple Japan, sap xep tien lai tu cao xuong thap va tu dong cap nhat moi 1 phut.

## Chuc nang

- Web dashboard tai `http://localhost:3000`
- Lay nhieu san pham iPhone 18 tu cac trang kaitori trong `sources.json`
- So sanh `gia thu mua - gia Apple`
- Sap xep profit tu cao den thap
- Luu du lieu moi nhat vao `data/prices.json`
- Gui Discord webhook khi gia thu mua hoac profit thay doi
- Cron mac dinh: `* * * * *`

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
CHECK_CRON=* * * * *
```

Khong co `DISCORD_WEBHOOK_URL` thi dashboard van chay, chi khong gui thong bao Discord.

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

## Luu y

Gia Apple trong `sources.json` dang la bang cau hinh manual de tranh loi do Apple Shop render theo JavaScript/region. Khi Apple thay gia, cap nhat block `apple-iphone18-manual`.
