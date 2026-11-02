import http from "http";

export function initHealthServer(port = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "HEALTHY",
          uptime: process.uptime(),
          version: "1.0.0",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`[Healthcheck] Telemetry endpoint running on :${port}/healthz`);
  });
}