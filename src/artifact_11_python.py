import hmac, hashlib

  computed = hmac.new(b"HMAC_SECRET", request.raw_body, hashlib.sha256).hexdigest()
  assert hmac.compare_digest(computed, request.headers["X-Kronos-Signature"])