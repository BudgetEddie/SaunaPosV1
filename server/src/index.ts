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

app.post("/lockers", async (req, res) => {
  const { number, gender } = req.body;
  if (!number || !gender) {
    return res.status(400).json({ error: "number and gender are required" });
  }
  const locker = await prisma.locker.create({ data: { number, gender } });
  res.status(201).json(locker);
});

// ---- Visits + billing ----

app.get("/visits/active", async (_req, res) => {
  const visits = await prisma.visit.findMany({
    where: { checkOutAt: null },
    include: { customer: true, locker: true, bill: { include: { lineItems: true } } },
    orderBy: { checkInAt: "desc" },
  });
  res.json(visits);
});

app.post("/check-in", async (req, res) => {
  const { customerId, lockerId } = req.body;
  if (!lockerId) {
    return res.status(400).json({ error: "Pick a locker before checking in" });
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const locker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!locker) {
    return res.status(404).json({ error: "Locker not found" });
  }
  if (locker.status !== "AVAILABLE") {
    return res.status(409).json({ error: `Locker ${locker.number} is not available` });
  }
  if (locker.gender !== customer.gender) {
    return res.status(409).json({ error: `Locker ${locker.number} is not in this customer's locker pool` });
  }

  const [updatedLocker, newVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: locker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.create({ data: { customerId: customer.id, lockerId: locker.id } }),
  ]);

  const bill = await prisma.bill.create({ data: { visitId: newVisit.id } });
  const visit = { ...newVisit, customer, locker: updatedLocker, bill: { ...bill, lineItems: [] } };

  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

// Add a charge to an open bill — a drink, a treatment, a towel rental
app.post("/visits/:visitId/change-locker", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { lockerId } = req.body;

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { customer: true } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  const newLocker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!newLocker) {
    return res.status(404).json({ error: "Locker not found" });
  }
  if (newLocker.status !== "AVAILABLE") {
    return res.status(409).json({ error: `Locker ${newLocker.number} is not available` });
  }
  if (newLocker.gender !== visit.customer.gender) {
    return res.status(409).json({ error: `Locker ${newLocker.number} is not in this customer's locker pool` });
  }

  const [freedLocker, claimedLocker, updatedVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: visit.lockerId }, data: { status: "AVAILABLE" } }),
    prisma.locker.update({ where: { id: newLocker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.update({ where: { id: visitId }, data: { lockerId: newLocker.id } }),
  ]);

  io.emit("locker:updated", freedLocker);
  io.emit("locker:updated", claimedLocker);
  io.emit("visit:locker-changed", updatedVisit);
  res.json(updatedVisit);
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));