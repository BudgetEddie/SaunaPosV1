import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// EDIT THESE two passwords before running. Rerunning this script later
// with new passwords is also how you reset a forgotten one.
const USERS = [
  { username: "owner",     displayName: "Owner",      role: Role.ADMIN, password: "Test1234!" },
  { username: "frontdesk", displayName: "Front Desk", role: Role.STAFF, password: "Test12345!" },
];

async function main() {
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.upsert({
      where: { username: u.username },
      update: { displayName: u.displayName, role: u.role, passwordHash },
      create: { username: u.username, displayName: u.displayName, role: u.role, passwordHash },
    });
    console.log(`Saved user ${u.username} (${u.role})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());