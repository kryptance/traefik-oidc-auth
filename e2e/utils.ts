import * as fs from "fs";
import * as path from "path";

// This will be set by the test setup
let traefikApiPort: number | undefined;

export function setTraefikApiPort(port: number) {
  traefikApiPort = port;
}

export async function configureTraefik(yaml: string, waitForReady = true) {
  const filePath = path.join(__dirname, ".http.yml");

  let existing: string = "";

  if (fs.existsSync(filePath))
    existing = fs.readFileSync(filePath).toString();

  if (existing !== yaml) {
    fs.writeFileSync(filePath, yaml);

    if (waitForReady) {
      // Wait for Traefik to detect the file change
      await new Promise(r => setTimeout(r, 2000));

      // Only check API if port is set
      if (traefikApiPort) {
        // Poll until Traefik has reloaded the configuration
        console.log("Waiting for Traefik to reload configuration...");
        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
          try {
            // Check if configuration has been loaded by verifying middleware presence
            const response = await fetch(`http://localhost:${traefikApiPort}/api/overview`, {
              signal: AbortSignal.timeout(1000)
            });

            if (response.ok) {
              // Configuration loaded successfully
              console.log("Traefik configuration reloaded successfully");
              // Give it a bit more time to fully stabilize
              await new Promise(r => setTimeout(r, 1000));
              return;
            }
          } catch (e) {
            // Traefik not ready yet, continue waiting
          }

          if (i === maxAttempts - 1) {
            console.warn("Warning: Traefik may not have fully reloaded configuration");
          }

          await new Promise(r => setTimeout(r, 1000));
        }
      } else {
        // Fallback to fixed wait time if port is not set
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}
