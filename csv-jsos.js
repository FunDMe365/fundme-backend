const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const folder = path.join(__dirname, "sheet_exports");

function csvToJson(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

async function main() {
  const files = fs.readdirSync(folder).filter(f => f.endsWith(".csv"));
  for (const file of files) {
    const filePath = path.join(folder, file);
    const json = await csvToJson(filePath);
    fs.writeFileSync(
      path.join(folder, file.replace(".csv", ".json")),
      JSON.stringify(json, null, 2)
    );
    console.log(`${file} -> JSON saved`);
  }
}

main().catch(console.error);
