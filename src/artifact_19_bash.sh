# Verify process integrity and active WebSocket listeners
curl -f http://localhost:8080/healthz || exit 1