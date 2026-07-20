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

  const [updatedLocker, newVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: locker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.create({ data: { customerId: customer.id, lockerId: locker.id } }),
  ]);

  // A bill starts empty the moment someone checks in, ready to collect charges
  const bill = await prisma.bill.create({ data: { visitId: newVisit.id } });
  const visit = { ...newVisit, customer, locker: updatedLocker, bill: { ...bill, lineItems: [] } };

  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

// Add a charge to an open bill — a drink, a treatment, a towel rental
app.post("/bills/:billId/line-items", async (req, res) => {
  const billId = Number(req.params.billId);
  const { description, amount } = req.body;
  if (!description || typeof amount !== "number") {
    return res.status(400).json({ error: "description and amount are required" });
  }
  const lineItem = await prisma.billLineItem.create({ data: { billId, description, amount } });
  io.emit("bill:line-item-added", { billId, lineItem });
  res.status(201).json(lineItem);
});

app.post("/check-out", async (req, res) => {
  const { visitId, paymentMethod } = req.body;
  if (!paymentMethod) {
    return res.status(400).json({ error: "paymentMethod is required to check out" });
  }
  const visit = await prisma.visit.findUnique({ where: { id: visitId } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  const [updatedVisit, updatedLocker, updatedBill] = await prisma.$transaction([
    prisma.visit.update({ where: { id: visitId }, data: { checkOutAt: new Date() } }),
    prisma.locker.update({ where: { id: visit.lockerId }, data: { status: "AVAILABLE" } }),
    prisma.bill.update({ where: { visitId }, data: { paymentMethod, paidAt: new Date() } }),
  ]);

  io.emit("visit:checked-out", updatedVisit);
  io.emit("locker:updated", updatedLocker);
  io.emit("bill:paid", updatedBill);
  res.json({ visit: updatedVisit, bill: updatedBill });
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));