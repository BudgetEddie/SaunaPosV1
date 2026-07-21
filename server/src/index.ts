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

// ---- Settings ----

async function getSettings() {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, taxRate: 0.13 },
  });
}

app.get("/settings", async (_req, res) => {
  res.json(await getSettings());
});

app.put("/settings", async (req, res) => {
  const { taxRate } = req.body;
  if (typeof taxRate !== "number" || taxRate < 0 || taxRate > 1) {
    return res.status(400).json({ error: "taxRate must be a number between 0 and 1 (e.g. 0.13 for 13%)" });
  }
  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: { taxRate },
    create: { id: 1, taxRate },
  });
  io.emit("settings:updated", settings);
  res.json(settings);
});

// ---- Menu ----

app.get("/categories", async (_req, res) => {
  const categories = await prisma.category.findMany({
    include: { items: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

app.post("/categories", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const category = await prisma.category.create({ data: { name } });
    io.emit("menu:updated", {});
    res.status(201).json(category);
  } catch {
    res.status(409).json({ error: `A category named "${name}" already exists` });
  }
});

app.put("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const category = await prisma.category.update({ where: { id }, data: { name } });
  io.emit("menu:updated", {});
  res.json(category);
});

app.delete("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });
  if (itemCount > 0) {
    return res.status(409).json({ error: "Move or delete this category's items first" });
  }
  await prisma.category.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
});

app.post("/menu-items", async (req, res) => {
  const { categoryId, name, price, description } = req.body;
  if (!categoryId || !name || typeof price !== "number") {
    return res.status(400).json({ error: "categoryId, name, and price are required" });
  }
  const item = await prisma.menuItem.create({ data: { categoryId, name, price, description } });
  io.emit("menu:updated", {});
  res.status(201).json(item);
});

app.put("/menu-items/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { categoryId, name, price, description } = req.body;
  const item = await prisma.menuItem.update({
    where: { id },
    data: { categoryId, name, price, description },
  });
  io.emit("menu:updated", {});
  res.json(item);
});

app.delete("/menu-items/:id", async (req, res) => {
  const id = Number(req.params.id);
  await prisma.menuItem.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
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

  const settings = await getSettings();
  const bill = await prisma.bill.create({ data: { visitId: newVisit.id, taxRate: settings.taxRate } });
  const visit = { ...newVisit, customer, locker: updatedLocker, bill: { ...bill, lineItems: [] } };

  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

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