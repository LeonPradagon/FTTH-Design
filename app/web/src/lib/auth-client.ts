import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";

export const authClient = createAuthClient({
  plugins: [
    adminClient({
      roles: {
        admin: adminAc,
        engineer: userAc,
        viewer: userAc,
      },
    }),
  ],
});

export const {
  changePassword,
  deleteUser,
  signIn,
  signOut,
  signUp,
  useSession,
} = authClient;
