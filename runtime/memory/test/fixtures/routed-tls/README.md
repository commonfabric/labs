# Routed memory TLS fixture

`localhost.key` is public test data, used only by the private TLS listener test
in `routed-data.test.ts`. The self-signed Ed25519 server certificate covers
`127.0.0.1` and is valid for a century. The test client trusts it as its only
certificate authority; certificate verification stays enabled.

To regenerate the pair from this directory, use OpenSSL 1.1.1 or later (the
LibreSSL that macOS ships as `openssl` does not generate Ed25519 keys):

```sh
openssl req -x509 -newkey ed25519 -nodes \
  -keyout localhost.key -out localhost.crt -days 36500 -subj /CN=localhost \
  -addext 'subjectAltName=IP:127.0.0.1' \
  -addext 'basicConstraints=critical,CA:FALSE'
```
