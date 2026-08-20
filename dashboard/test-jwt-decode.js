const { betterAuth } = require("better-auth");
const { jwt } = require("better-auth/plugins");
const jwtLib = require("jsonwebtoken");

const auth = betterAuth({
  secret: "super_secret_key",
  plugins: [jwt()]
});

// Create a dummy JWT token
const token = jwtLib.sign(
  {
    session: { id: "sess_123", userId: "usr_123" },
    user: { id: "usr_123", email: "admin@surge.com", role: "admin" }
  },
  "super_secret_key",
  { expiresIn: '1h' }
);
console.log("Mock Token Payload:", jwtLib.decode(token));
