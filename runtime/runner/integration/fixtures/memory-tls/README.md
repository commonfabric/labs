# Memory TLS fixture

`localhost.key` is public test data, used only by the disposable localhost TLS
proxy in `memory-socket.test.ts`. The self-signed server certificate covers
`localhost` and `127.0.0.1`. The client trusts it through Deno's `--cert`
option; certificate verification stays enabled.

To regenerate the pair from this directory:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost.key -out localhost.crt -days 36500 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth'
```
