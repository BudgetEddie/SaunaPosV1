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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// List every customer, newest first
app.get("/customers", async (_req, res) => {
  const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" } });
  res.json(customers);
});

// Create a new customer
app.post("/customers", async (req, res) => {
  const { firstName, lastName, gender, phone, email, notes } = req.body;
  if (!firstName || !lastName || !gender) {
    return res.status(400).json({ error: "firstName, lastName, and gender are required" });
  }
  const customer = await prisma.customer.create({
    data: { firstName, lastName, gender, phone, email, notes },
  });
  io.emit("customer:created", customer); // instantly show it on every open terminal
  res.status(201).json(customer);
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));