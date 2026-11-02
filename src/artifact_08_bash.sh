# Verify health metrics & RPC heartbeat
curl -I http://localhost:8080/health
# HTTP/1.1 200 OK
# Content-Type: application/json
# {"status":"HEALTHY","synced_slot":278912341,"active_streams":142}