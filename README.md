# Kaitori Discord Bot

Dashboard theo dõi giá thu mua iPhone 18, so sánh với giá gốc Apple Japan, sắp xếp tiền lãi từ cao xuống thấp và tự động cập nhật mỗi 30 giây.

## Chức năng

- Web dashboard tại `http://localhost:3000`
- Lấy nhiều sản phẩm iPhone 18 từ các trang kaitori trong `sources.json`
- So sánh `giá thu mua - giá Apple`
- Sắp xếp lợi nhuận từ cao đến thấp
- Dashboard ưu tiên scrape live khi người dùng mở trang; Upstash Redis chỉ là cache tùy chọn
- Gửi Discord webhook khi giá thu mua hoặc lợi nhuận thay đổi
- Local cron mặc định: `*/1 * * * *`
- Vercel Cron gọi `/api/cron/check-prices` mỗi phút theo `vercel.json`

## Cài Đặt

```bash
npm install
npm start
```

Nếu PowerShell chặn `npm.ps1`, dùng:

```bash
npm.cmd install
npm.cmd start
```

## Discord Webhook

Tạo file `.env` từ `.env.example`:

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

Không có `DISCORD_WEBHOOK_URL` thì dashboard vẫn chạy, chỉ không gửi thông báo Discord.

## Deploy Vercel

Trên Vercel, không nên dùng `node-cron` và không thể ghi giá vào file JSON vì serverless filesystem read-only/không bền. App này đã có endpoint `GET /api/cron/check-prices` và `vercel.json` để Vercel Cron gọi mỗi phút.

Upstash Redis là tùy chọn. Nếu Redis lỗi hoặc không cấu hình, dashboard vẫn gọi `/api/live-prices` để lấy giá mới trực tiếp từ các nguồn. Redis chỉ giúp cache state cho cron/webhook.

Set environment variables trên Vercel:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
STATE_KEY=kaitori:prices
ENABLE_INTERNAL_CRON=false
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Nếu đặt `CRON_SECRET`, gọi cron thủ công cần header `Authorization: Bearer <secret>` hoặc query `?token=<secret>`. Lưu ý: Vercel Cron mặc định không gắn custom Authorization header, nên chỉ bật `CRON_SECRET` nếu bạn dùng cron bên ngoài hoặc thêm token vào path cron.

Khi một nguồn lỗi tạm thời, app giữ giá cũ của nguồn đó và gắn cờ `stale` để dashboard hiện "Giá cũ - nguồn đang lỗi" thay vì xóa bảng giá.

## Cấu Hình Nguồn Giá

Sửa `sources.json`.

Nguồn Apple có thể để dạng manual:

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

Nguồn thu mua:

```json
{
  "id": "pastec-iphone18-pro-max",
  "shop": "Mobaste/Pastec",
  "type": "buyback",
  "enabled": true,
  "url": "https://pastec.net/iphone?series_child_id=644"
}
```

Parser sẽ tìm các dòng có dạng `iPhone18 Pro Max 256GB` và giá yen gần đó. Các trang render bằng JavaScript/SPA có thể cần thay URL index bằng API URL nếu HTML không có dữ liệu sản phẩm.

## API

- `GET /api/prices`: dữ liệu bảng lợi nhuận mới nhất
- `GET /api/live-prices`: scrape trực tiếp và trả giá mới, không phụ thuộc Redis/file
- `GET /api/sources`: cấu hình nguồn
- `POST /api/check`: kiểm tra ngay
- `GET /api/cron/check-prices`: endpoint cho Vercel Cron/cron bên ngoài

## Lưu Ý

Giá Apple trong `sources.json` đang là bảng cấu hình manual để tránh lỗi do Apple Shop render theo JavaScript/region. Khi Apple thay giá, cập nhật block `apple-iphone18-manual`.
