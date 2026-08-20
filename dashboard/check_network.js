const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('response', response => {
    if (!response.ok()) {
      console.log('FAILED RESPONSE:', response.status(), response.url());
    }
  });
  
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle0', timeout: 15000 });
  await browser.close();
})();
