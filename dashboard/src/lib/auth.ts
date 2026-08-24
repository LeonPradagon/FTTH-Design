import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000"],
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  plugins: [
    jwt(),
    admin()
  ],
  emailAndPassword: {
    enabled: true,
  },
  user: {
    deleteUser: {
      enabled: true
    },
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user"
      }
    }
  }
});
