// Telemetry Server Extension inside src/sentinel-daemon.ts
import * as http from "http";

const telemetryPort = process.env.TELEMETRY_PORT || 9090;
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "HEALTHY",
      uptime: process.uptime(),
      connectionActive: connection !== null,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(telemetryPort, () => {
  console.log(`[TELEMETRY] Metrics & healthchecks listening on :${telemetryPort}`);
});