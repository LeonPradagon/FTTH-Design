import { auth } from "./src/lib/auth";

async function testEndToEnd() {
  try {
    // 1. Simulate frontend calling login (this returns the Set-Cookie header)
    console.log("Attempting to login...");
    const res = await fetch("http://localhost:3001/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://localhost:3001"
      },
      body: JSON.stringify({
        email: "admin@surge.com",
        password: "admin123"
      })
    });
    
    if (!res.ok) {
      console.error("Login failed:", res.status, await res.text());
      return;
    }
    
    // 2. Extract cookie
    const cookies = res.headers.get("set-cookie");
    console.log("Login successful! Got cookies.");
    
    // Extract raw token from cookie
    let rawToken = "";
    if (cookies) {
      const match = cookies.match(/better-auth\.session_token=([^;]+)/);
      if (match) rawToken = match[1];
    }
    
    // 3. Make request to Python API proxy
    console.log("Testing backend proxy with parsed cookie...");
    const proxyRes = await fetch("http://localhost:3001/api/proxy/api/projects", {
      headers: {
        "Cookie": `better-auth.session_token=${rawToken}`
      }
    });
    console.log("Proxy API Status:", proxyRes.status);
    if (proxyRes.ok) {
        console.log("Success! Proxy returned:", (await proxyRes.json()).length, "projects.");
    } else {
        console.log("Proxy failed:", await proxyRes.text());
    }
    

    
  } catch (e) {
    console.error("Test error:", e);
  }
}

testEndToEnd();
