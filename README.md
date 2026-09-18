# Kaitori Discord Bot

Bot theo dõi giá iPhone từ các trang kaitori và gửi thông báo Discord khi giá thay đổi.

## Chức năng
- Web dashboard tại `http://localhost:3000`
- Kiểm tra giá tự động theo cron
- Gửi Discord khi giá tăng/giảm
- Nút `Kiểm tra ngay`
- Lưu giá gần nhất tại `data/prices.json`
- Hỗ trợ nhiều shop/model/dung lượng

## 1. Cài đặt
```bash
npm install
```

## 2. Discord Webhook
Trong Discord:
1. Server Settings
2. Integrations
3. Webhooks
4. New Webhook
5. Copy Webhook URL

Tạo file `.env` từ `.env.example`:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PORT=3000
CHECK_CRON=*/5 * * * *
```

`*/5 * * * *` = kiểm tra mỗi 5 phút.

## 3. Thêm trang kaitori
Sửa `sources.json`:

```json
[
  {
    "id": "shop-a-18promax-256",
    "shop": "Shop A",
    "model": "iPhone 18 Pro Max",
    "storage": "256GB",
    "url": "https://shop.example/iphone18",
    "priceSelector": ".purchase-price",
    "enabled": true
  }
]
```

`priceSelector` là CSS selector của phần giá trên website.

Ví dụ HTML:
```html
<div class="purchase-price">262,000円</div>
```

thì selector là:
```text
.purchase-price
```

## 4. Chạy
```bash
npm start
```

Mở:
```text
http://localhost:3000
```

## Deploy
Có thể chạy trên:
- VPS
- Railway
- Render
- Fly.io
- PC cũ chạy 24/7

### Lưu ý về Vercel
Bot này dùng cron chạy trong process Node và lưu JSON local, nên không phù hợp nhất với Vercel serverless.
Nếu muốn deploy Vercel, nên đổi phần lưu dữ liệu sang Supabase và dùng Vercel Cron.

## Website chặn scraper
Một số kaitori dùng Cloudflare / JavaScript rendering.
Nếu gặp trang như vậy, cần đổi riêng nguồn đó sang:
- API chính thức nếu có
- Playwright
- Puppeteer
- hoặc lấy dữ liệu từ một trang so sánh giá có HTML tĩnh

Không nên đặt tần suất quá cao. 5–15 phút/lần thường hợp lý.
