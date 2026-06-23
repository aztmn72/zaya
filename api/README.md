# ZAYA Lead API

Backend API for ZAYA lead capture form with Telegram Bot integration.

## ENV Variables (Required)

Set these environment variables before running:

```bash
export TELEGRAM_BOT_TOKEN="your_bot_token_here"
export TELEGRAM_CHAT_ID="your_chat_id_here"
```

## How to Get Telegram Bot Token

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Enter a name: `ZAYA Lead Bot`
4. Enter a username: `zaya_lead_bot`
5. BotFather will give you a token like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
6. Copy this token

## How to Get Telegram Chat ID

1. Create a group in Telegram (or use existing)
2. Add your bot to the group
3. Send any message in the group
4. Open this URL in browser (replace TOKEN):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
5. Find `"chat":{"id":` — that number is your CHAT_ID
6. It's usually a negative number like `-1001234567890`

## Quick Start

```bash
cd api
npm install
export TELEGRAM_BOT_TOKEN="YOUR_TOKEN"
export TELEGRAM_CHAT_ID="YOUR_CHAT_ID"
npm start
```

## Deploy to Railway

1. Push code to GitHub
2. Go to [railway.app](https://railway.app)
3. Create new project
4. Add environment variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat ID
5. Deploy

## Deploy to Render

1. Push code to GitHub
2. Go to [render.com](https://render.com)
3. Create new Web Service from `aztmn72/zaya` repo
4. Set build command: `cd api && npm install`
5. Set start command: `cd api && npm start`
6. Add environment variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat ID
7. Deploy

## Deploy to Vercel

1. Push code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import repository
4. Add environment variables in Settings
5. Deploy

## API Endpoints

### POST /api/lead
Submit a new lead.

**Request body:**
```json
{
  "name": "Иван",
  "phone": "+7 (3452) 922-777",
  "email": "ivan@example.com",
  "topic": "Предзаказ",
  "message": "Хочу купить контроллер",
  "source": "https://aztmn72.github.io/website/"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Заявка успешно отправлена",
  "telegram": "sent"
}
```

### GET /api/health
Health check endpoint.

## Telegram Message Format

```
🔔 Новая заявка на ZAYA
━━━━━━━━━━━━━━━━━━

👤 Имя: Иван
📱 Телефон: +7 (3452) 922-777
📧 Email: ivan@example.com
📋 Тема: Предзаказ
💬 Сообщение: Хочу купить контроллер

━━━━━━━━━━━━━━━━━━
🔗 Источник: https://aztmn72.github.io/website/
🕐 Дата: 18.06.2026, 12:00:00
```
