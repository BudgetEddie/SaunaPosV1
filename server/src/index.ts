import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.get("/health", async (_req, res) => {
  const pings = await prisma.ping.count();
  res.json({ status: "ok", pingsInDatabase: pings });
});

app.post("/ping", async (_req, res) => {
  const ping = await prisma.ping.create({ data: { message: "hello from the sauna" } });
  io.emit("ping:created", ping); // instantly tells every connected browser tab
  res.json(ping);
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));