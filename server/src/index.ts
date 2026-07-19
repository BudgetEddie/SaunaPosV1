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

// ---- Customers ----

app.get("/customers", async (_req, res) => {
  const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" } });
  res.json(customers);
});

app.post("/customers", async (req, res) => {
  const { firstName, lastName, gender, phone, email, notes } = req.body;
  if (!firstName || !lastName || !gender) {
    return res.status(400).json({ error: "firstName, lastName, and gender are required" });
  }
  const customer = await prisma.customer.create({
    data: { firstName, lastName, gender, phone, email, notes },
  });
  io.emit("customer:created", customer);
  res.status(201).json(customer);
});

// ---- Lockers ----

app.get("/lockers", async (_req, res) => {
  const lockers = await prisma.locker.findMany({ orderBy: [{ gender: "asc" }, { number: "asc" }] });
  res.json(lockers);
});

// One-time setup use, for seeding your physical locker pool — see Part 2's curl step below
app.post("/lockers", async (req, res) => {
  const { number, gender } = req.body;
  if (!number || !gender) {
    return res.status(400).json({ error: "number and gender are required" });
  }
  const locker = await prisma.locker.create({ data: { number, gender } });
  res.status(201).json(locker);
});

// ---- Visits (check-in / check-out) ----

app.get("/visits/active", async (_req, res) => {
  const visits = await prisma.visit.findMany({
    where: { checkOutAt: null },
    include: { customer: true, locker: true },
    orderBy: { checkInAt: "desc" },
  });
  res.json(visits);
});

app.post("/check-in", async (req, res) => {
  const { customerId } = req.body;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const locker = await prisma.locker.findFirst({
    where: { gender: customer.gender, status: "AVAILABLE" },
  });
  if (!locker) {
    return res.status(409).json({ error: `No available lockers for ${customer.gender.toLowerCase()}` });
  }

  const [updatedLocker, visit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: locker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.create({
      data: { customerId: customer.id, lockerId: locker.id },
      include: { customer: true, locker: true },
    }),
  ]);

  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

app.post("/check-out", async (req, res) => {
  const { visitId } = req.body;
  const visit = await prisma.visit.findUnique({ where: { id: visitId } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  const [updatedVisit, updatedLocker] = await prisma.$transaction([
    prisma.visit.update({ where: { id: visitId }, data: { checkOutAt: new Date() } }),
    prisma.locker.update({ where: { id: visit.lockerId }, data: { status: "AVAILABLE" } }),
  ]);

  io.emit("visit:checked-out", updatedVisit);
  io.emit("locker:updated", updatedLocker);
  res.json(updatedVisit);
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));