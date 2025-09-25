import * as fs from "fs";
import * as path from "path";

export async function configureTraefik(yaml: string, waitForReady = true) {
  const filePath = path.join(__dirname, ".http.yml");

  let existing: string = "";

  if (fs.existsSync(filePath))
    existing = fs.readFileSync(filePath).toString();

  if (existing !== yaml) {
    fs.writeFileSync(filePath, yaml);

    if (waitForReady) {
      // Wait some time for traefik to reload the config
      await new Promise(r => setTimeout(r, 3000));

      // Additional wait to ensure Traefik is fully ready after config reload
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
