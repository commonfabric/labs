# touch-gate test certificates

Self-signed certificates for tests of `cf view`'s touch-gate client. A fake
server presents `server.crt` with the private key `server.key`, and the client
expects either that certificate or `other.crt`. Each was made with:

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out NAME.key
openssl req -new -x509 -key NAME.key -subj /CN=touch-gate -days 36500 -out NAME.crt
```
