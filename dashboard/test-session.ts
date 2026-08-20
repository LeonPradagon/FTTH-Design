import { auth } from "./src/lib/auth";
import { headers } from "next/headers";

async function test() {
  try {
    const fakeHeaders = new Headers({
      'Cookie': 'better-auth.session_token=BQsZlDrpdG0c9aTazf5qwkK9ER7XrgJm.TQUYiqdFM%2F4Dex9F6rnyrDlOFddg27jz8evR5IVgqS0%3D'
    });
    
    // We use the internal API
    const session = await auth.api.getSession({
      headers: fakeHeaders,
    });
    console.log("Session:", session);
  } catch (e) {
    console.error("Error getting session:");
    console.error(e);
  }
}

test();
