const { betterAuth } = require("better-auth");
const auth = betterAuth({
  secret: "super_secret_key"
});
console.log(auth);
