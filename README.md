<div align="center">

# WappBuzz

**Node.js · Automation · REST API**
WappBuzz is a Node.js based WhatsApp API Automation
WhatsApp automation platform built on top of multi-device library.
Connect your WhatsApp account via QR code and send messages programmatically through a clean REST API.

![Status](https://img.shields.io/badge/Status-Beta%20Version-orange?style=flat-square)
![Node](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square&logo=nodedotjs)
![License](https://img.shields.io/badge/License-Private-red?style=flat-square)

</div>

---

## Features

| Feature | Status |
|---------|--------|
| QR Code Authentication | ✅ Available |
| REST API | ✅ Available |
| Send Text Messages | ✅ Available |
| Health Check API | ✅ Available |
| Real-time Socket.IO Events | ✅ Available |
| WhatsApp Multi-Device Support | 🔜 Upcoming |
| Pairing Code Login | 🔜 Upcoming |
| Webhook Support | 🔜 Upcoming |
| Media Messaging | 🔜 Upcoming |
| Group Management | 🔜 Upcoming |

---

## Requirements

- **Node.js** 20+
- **MySQL** (for upcoming features)
- **npm**
- **PM2** (recommended for production)

---

## Installation

```bash
npm install
```

---

## Configuration

Before starting, open `Config.js` and set your access key:

```js
module.exports = {
    host:        "http://localhost",
    port:        3000,
    access_key:  "YOUR_SECRET_KEY",   // ← Set this
    instance_id: "",                  // ← Auto-populated on first run
};
```

---

## Run

### Production

```bash
npm start
```

### Development (with auto-restart)

```bash
npm run dev
```

---

## PM2 (Production Process Manager)

### Start Application

```bash
pm2 start app.js --name wappbuzz
```

### Restart Application

```bash
pm2 restart wappbuzz
```

### Save PM2 Process List

```bash
pm2 save
```

### View Logs

```bash
pm2 logs wappbuzz
```

### Monitor Processes

```bash
pm2 monit
```

---

## API Quick Start

### Base URL

```
http://localhost:3000
```

Every request requires an `access_token` that matches the `access_key` in `Config.js`.

---

### Available Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/create_instance` | Create a new WhatsApp instance |
| `GET` | `/api/get_qrcode` | Get QR code for device authentication |
| `POST` | `/api/send` | Send a text message |
| `GET` | `/api/health` | Check WhatsApp connection status |
| `POST` | `/api/health` | Check WhatsApp connection status (JSON body) |

---

### 1. Create Instance

Create a new WhatsApp instance and receive a QR code URL.

```http
POST /api/create_instance?access_token=YOUR_ACCESS_KEY
```

**Example**

```http
POST http://localhost:3000/api/create_instance?access_token=YOUR_ACCESS_KEY
```

**Success Response**

```json
{
    "status": "success",
    "message": "Instance created successfully",
    "data": {
        "instance_id": "T5G918NLSZS8P",
        "qr_code_url": "http://localhost:3000/api/get_qrcode?access_token=YOUR_ACCESS_KEY&instance_id=T5G918NLSZS8P",
        "next_step": "Scan the QR code with your WhatsApp mobile app to connect"
    }
}
```

> **Note:** The returned `instance_id` is automatically saved to `Config.js`.

---

### 2. Get QR Code

Retrieve the QR code as a Base64 PNG image and scan it with WhatsApp on your phone.

```http
GET /api/get_qrcode?instance_id=YOUR_INSTANCE_ID&access_token=YOUR_ACCESS_KEY
```

**Example**

```http
GET http://localhost:3000/api/get_qrcode?instance_id=YOUR_INSTANCE_ID&access_token=YOUR_ACCESS_KEY
```

**Success Response**

```json
{
    "status": "success",
    "message": "Success",
    "base64": "data:image/png;base64,..."
}
```

> **Tip:** Use the `base64` value directly as an `<img src="...">` in HTML to render the QR code.

---

### 3. Send Text Message

Send a WhatsApp text message to an individual or a group.

```http
POST /api/send
Content-Type: application/json
```

**Request Body**

```json
{
    "number": "917357935653",
    "type": "text",
    "message": "Hello from WappBuzz!",
    "instance_id": "YOUR_INSTANCE_ID",
    "access_token": "YOUR_ACCESS_KEY"
}
```

**Parameters**

| Field | Required | Description |
|-------|----------|-------------|
| `number` | ✅ | Mobile number with country code (e.g. `917357935653`) or Group JID (e.g. `120363290960XXXXXX@g.us`) |
| `type` | ✅ | Must be `text` |
| `message` | ✅ | Plain-text message to send |
| `instance_id` | ✅ | Your instance ID from `Config.js` |
| `access_token` | ✅ | Your access key from `Config.js` |

**Success Response**

```json
{
    "status": "success",
    "message": "Message sent successfully.",
    "data": {
        "number": "917357935653",
        "type": "text",
        "message_id": "XXXXXXXXXXXXXXXX",
        "timestamp": 1751940000
    }
}
```

**Error Responses**

| Response | Reason |
|----------|--------|
| `Required parameters are missing.` | One or more fields not provided |
| `Unsupported message type.` | `type` is not `text` |
| `Invalid access token.` | `access_token` does not match `Config.js` |
| `Invalid instance ID.` | `instance_id` does not match `Config.js` |
| `WhatsApp is not connected.` | Session not established — scan QR first |
| `Failed to send message.` | Unexpected Baileys / server error |

---

### Authentication

Every API call requires:

| Field | Where | Description |
|-------|-------|-------------|
| `access_token` | Query param or JSON body | Must match `access_key` in `Config.js` |
| `instance_id` | Query param or JSON body | Must match `instance_id` in `Config.js` (not required for Create Instance) |

---

### 4. Health Check

Check whether WhatsApp is connected and get live phone/name details.

**GET (query string)**

```http
GET /api/health?instance_id=YOUR_INSTANCE_ID&access_token=YOUR_ACCESS_KEY
```

**POST (JSON body)**

```http
POST /api/health
Content-Type: application/json
```

```json
{
    "instance_id": "YOUR_INSTANCE_ID",
    "access_token": "YOUR_ACCESS_KEY"
}
```

**Success Response — Connected**

```json
{
    "status": "success",
    "message": "WhatsApp is connected.",
    "data": {
        "instance_id": "YOUR_INSTANCE_ID",
        "phone": "917357935653",
        "push_name": "MQ TECH GURU",
        "connection": "connected",
        "platform": "android",
        "socket": "connected",
        "socket_io": "connected",
        "timestamp": 1751960000
    }
}
```

**Error Response — Disconnected**

```json
{
    "status": "error",
    "message": "WhatsApp is disconnected.",
    "data": {
        "connection": "disconnected",
        "socket": "disconnected",
        "socket_io": "no clients"
    }
}
```

**Socket.IO Realtime Event**

Every health check emits `instance_health` to all connected Socket.IO clients:

```js
const socket = io("http://localhost:3000");
socket.on("instance_health", (data) => {
    console.log(data); // { instance_id, status, phone, push_name }
});
```

---

## Project Structure

```
wappbuzz/
├── app.js              # Express server & all API routes
├── Config.js           # Global configuration (host, port, keys)
├── package.json        # Dependencies & npm scripts
├── sessions/           # Baileys auth sessions (auto-created)
└── wappbuzz/
    ├── wappbuzz.js     # Core WhatsApp module (Baileys integration)
    ├── common.js       # Config updater & shared utilities
    └── extend.js       # Extended helpers

```

---

## Status

🚧 **Project is currently under active development.**

---

## Upcoming Features

| Feature | Description |
|---------|-------------|
| 🚀 API Documentation | Full interactive API docs |
| 📚 Postman Collection | Ready-to-import Postman workspace |
| 🤖 N8N Automation | Native N8N node integration |
| 👩🏼‍💻 Custom CRM | Built-in contact & conversation management |
| 📡 Webhooks | Real-time incoming message events |
| 📦 Installation Guide | Step-by-step VPS setup guide |
| 🐳 Docker Support | One-command Docker deployment |
| ☁️ VPS Deployment Guide | Nginx + PM2 production setup |
| 📝 Changelog | Version history and release notes |

---

## License

**Private Repository © MQ Tech Guru**  
Unauthorised copying, distribution, or modification of this software is strictly prohibited.
