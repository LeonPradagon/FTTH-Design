const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle2' });
  
  // Wait a couple of seconds for map to render
  await new Promise(r => setTimeout(r, 2000));
  
  await page.screenshot({ path: 'map_screenshot.png' });
  
  await browser.close();
})();
