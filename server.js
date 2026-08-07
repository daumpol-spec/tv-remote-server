/**
 * เซิร์ฟเวอร์กลาง — ทำหน้าที่เป็นตัวกลางระหว่าง:
 *  - "device"  : แอป Android บนกล่อง TV Box (ส่งภาพจอ / รับคำสั่งแตะ)
 *  - "admin"   : หน้าเว็บแอดมิน (ดูภาพ / ส่งคำสั่งแตะ)
 *
 * โครงสร้าง endpoint:
 *   ws(s)://host/ws/device?deviceId=xxx      Header: Authorization: Bearer <DEVICE_TOKEN>
 *   ws(s)://host/ws/admin?deviceId=xxx       Header: Authorization: Bearer <ADMIN_TOKEN>
 *
 * หมายเหตุด้านความปลอดภัย (สำคัญ ต้องทำก่อนใช้งานจริง):
 *  - เปลี่ยน token แบบ hardcode ด้านล่างเป็นระบบ auth จริง (DB + JWT/OAuth)
 *  - รันอยู่หลัง TLS (wss://) เท่านั้น เช่นผ่าน Nginx reverse proxy + Let's Encrypt
 *  - จำกัด 1 อุปกรณ์ให้มีแอดมินควบคุมได้ทีละคน หรือทำ audit log ว่าใครควบคุมเมื่อไหร่
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;

// หมายเหตุ: token นี้ hardcode ไว้เพื่อทดสอบเท่านั้น ใช้จริงต้องย้ายไป environment variable
const VALID_DEVICE_TOKENS = new Set(["BMmOIopjyjF7VWi-l4Jacfzm4Bz6X01y"]);
const VALID_ADMIN_TOKENS = new Set(["y5Ot9e45EzamgQjRh3GYonzwyyUqo6qt"]);

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// deviceId -> { deviceSocket, adminSockets: Set }
const rooms = new Map();

function getRoom(deviceId) {
  if (!rooms.has(deviceId)) {
    rooms.set(deviceId, { deviceSocket: null, adminSockets: new Set() });
  }
  return rooms.get(deviceId);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers["authorization"] || "";
  const headerToken = authHeader.replace("Bearer ", "");
  const queryToken = url.searchParams.get("token") || "";
  const token = headerToken || queryToken; // อุปกรณ์ Android ใช้ header ได้ / เบราว์เซอร์ใช้ query param
  const deviceId = url.searchParams.get("deviceId") || req.headers["x-device-id"];

  if (!deviceId) {
    socket.destroy();
    return;
  }

  if (url.pathname === "/ws/device") {
    if (!VALID_DEVICE_TOKENS.has(token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = "device";
      ws.deviceId = deviceId;
      wss.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws/admin") {
    if (!VALID_ADMIN_TOKENS.has(token)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = "admin";
      ws.deviceId = deviceId;
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  const room = getRoom(ws.deviceId);

  if (ws.role === "device") {
    room.deviceSocket = ws;
    console.log(`[device connected] ${ws.deviceId}`);
    broadcastToAdmins(room, JSON.stringify({ type: "device_status", online: true }));
  } else {
    room.adminSockets.add(ws);
    console.log(`[admin connected] watching ${ws.deviceId}`);
  }

  ws.on("message", (data, isBinary) => {
    if (ws.role === "device") {
      // ภาพจอ (binary) จากกล่อง -> ส่งต่อให้แอดมินทุกคนที่กำลังดูอุปกรณ์นี้
      broadcastToAdmins(room, data, isBinary);
    } else if (ws.role === "admin") {
      // คำสั่ง (JSON text) จากแอดมิน -> ส่งต่อให้กล่องเป้าหมายเท่านั้น
      if (room.deviceSocket && room.deviceSocket.readyState === WebSocket.OPEN) {
        room.deviceSocket.send(data);
      }
    }
  });

  ws.on("close", () => {
    if (ws.role === "device") {
      room.deviceSocket = null;
      console.log(`[device disconnected] ${ws.deviceId}`);
      broadcastToAdmins(room, JSON.stringify({ type: "device_status", online: false }));
    } else {
      room.adminSockets.delete(ws);
      console.log(`[admin disconnected] ${ws.deviceId}`);
    }
  });
});

function broadcastToAdmins(room, data, isBinary) {
  room.adminSockets.forEach((adminWs) => {
    if (adminWs.readyState === WebSocket.OPEN) {
      adminWs.send(data, { binary: isBinary });
    }
  });
}

server.listen(PORT, () => {
  console.log(`TV Remote server listening on port ${PORT}`);
});
