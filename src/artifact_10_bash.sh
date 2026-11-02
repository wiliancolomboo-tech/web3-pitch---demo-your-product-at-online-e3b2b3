curl -i http://localhost:8080/healthz
   # Expect: HTTP/1.1 200 OK {"status":"UP","metrics":{...}}