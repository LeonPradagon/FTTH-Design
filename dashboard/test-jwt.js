const { betterAuth } = require("better-auth");
const { jwt } = require("better-auth/plugins");
const auth = betterAuth({
  secret: "super_secret_key",
  plugins: [jwt()]
});
console.log(auth);
