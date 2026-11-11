import { writeFileSync } from "node:fs";
import { initBackend } from "../../src/backend";
import { fetchAllFeeds } from "../../src/backend/sentiment/scrapers";
import { nodePlatform } from "../nodePlatform";
initBackend(nodePlatform());
const items = await fetchAllFeeds();
writeFileSync("tests/parity/headlines.json", JSON.stringify(items.map((i) => i.headline)));
console.log(`${items.length} headlines`);
