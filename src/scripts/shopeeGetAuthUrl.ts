import { buildShopeeAuthUrl } from "../services/shopeeAuth";

// Manual fallback: the in-GUI "Integrate" button on the Integrations page does this
// automatically via GET /api/integrations/shopee/auth-url. This script exists for
// double-checking the link is well-formed outside the browser.
function main() {
  console.log("Open this URL in a browser, log in, and authorize the shop:");
  console.log(buildShopeeAuthUrl());
}

main();
