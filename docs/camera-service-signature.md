# Camera service signature contract

Media Control signs camera-administration requests with
`MBFD-CAMERA-SERVICE-HMAC-SHA256-V1`. The camera edge verifies the same
canonical request after the public proxy has selected the upstream URI.

The canonical request is these newline-delimited fields, in order:

1. protocol identifier;
2. uppercase HTTP method;
3. exact post-proxy path plus canonical query;
4. lowercase hexadecimal SHA-256 of the exact raw request-body bytes (the hash
   of zero bytes when there is no body);
5. Unix timestamp in decimal milliseconds;
6. lowercase RFC 4122 version-4 nonce;
7. trimmed `If-Match` value, or an empty field;
8. normalized content type, or an empty field;
9. authenticated Media Control operator ID;
10. service key ID;
11. service key version.

The path is not decoded or re-encoded. Query names and values are decoded using
form query rules, RFC 3986 encoded, sorted by encoded name and then value, and
joined with `&`. Duplicate query fields are retained. Content type media types
and parameter names are lowercase; parameters are trimmed and sorted.

The signature is lowercase hexadecimal HMAC-SHA-256 over the UTF-8 canonical
request. It is sent as `X-Service-Signature` with
`X-Service-Timestamp`, `X-Service-Nonce`, `X-Service-Key-Id`,
`X-Service-Key-Version`, and the signed `X-Operator-Id`. The edge permits at
most 60 seconds of clock skew, compares signatures in constant time, and
persists accepted nonces for the full replay window.

During rotation the edge may hold one current and one previous key. Deploy the
new edge current key while retaining the old edge key as previous, switch Media
Control to the new current key, verify requests, and then remove the previous
edge key. API bearer tokens and signing keys are separate credentials.
