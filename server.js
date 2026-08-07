const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;

// TODO: ย้ายไปเก็บใน DB / environment variable จริง ห้าม hardcode ในโปรดักชัน
const VALID_DEVICE_TOKENS = new Set(["REPLACE_WITH_REAL_DEVICE_TOKEN"]);
const VALID_ADMIN_TOKENS = new Set(["REPLACE_WITH_REAL_ADMIN_TOKEN"]);

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
  const token = headerToken || queryToken;
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
      broadcastToAdmins(room, data, isBinary);
    } else if (ws.role === "admin") {
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
