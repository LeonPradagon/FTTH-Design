const { createAuthClient } = require('better-auth/react');
const authClient = createAuthClient({ baseURL: "http://localhost:3001" });
async function run() {
  const { data, error } = await authClient.signIn.email({ email: 'admin@surge.com', password: 'admin' });
  console.log("Error:", error);
  console.log("Data:", data);
  // We can check the cookies sent by the server via fetching manually
  const res = await fetch("http://localhost:3001/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: 'admin@surge.com', password: 'admin' })
  });
  console.log("Set-Cookie:", res.headers.get("set-cookie"));
}
run();
