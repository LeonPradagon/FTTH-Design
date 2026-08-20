async function run() {
  const res = await fetch("http://localhost:3001/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://localhost:3001" },
    body: JSON.stringify({ email: 'admin@surge.com', password: 'admin' })
  });
  console.log("Headers:");
  res.headers.forEach((value, key) => console.log(key, value));
  console.log("Body:", await res.text());
}
run();
