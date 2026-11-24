# common-identity

This package contains functionality encapsulating identity and key management.

> [!CAUTION]
> This is incomplete, experimental software and no guarantees are provided. This
> software contains unaudited cryptography. Continue reading for full details of
> current status and limitations.

## How it works

Using the [Web Authentication API], we use passkeys managed by authenticators
(like Yubikeys, iCloud Keychain, and Google Password Manager) to provide
cross-device authentication. With the [PRF extension], a static challenge
deterministically derives a 32-byte hash from a passkey. Typical WebAuthn usage
uses a server as a relying party, where a server records the passkey's public
key and additional metadata to map a key to a "user", however our usage
currently remains entirely client-side.

The derived 32-bytes is used as raw private key material for a `RootKey`, from
which all identities are derived. The `RootKey` is securely stored in IndexedDb
at a well-known location, and on page load, is retrieved, acting as a
pseudo-cookie for authentication, so that the user does not need to
reauthenticate their passkey.

Personas are deterministically derived from root keys, such that each `RootKey`
can derive any number of `PersonaKey`s. These personas are visible users to the
system, and these identites are used for signing transactions and delegating
ownership.

Similarly, a `SpaceKey` is a generated (non-derived) keypair representing an
identity of a "space". When `SpaceKey` is generated, it immediately delegates
access to a `PersonaKey` before burning its private key.

## Key Derivation

> [!WARNING]
> This needs a cryptographic review. Using a signed deterministic value as key
> material could be compromised by an attacker getting specific data signed by a
> root key.

Deriving a `PersonaKey` from a `RootKey` performs the following algorithm:

- `i` = Encode `name` into bytes
- `i` = Sign `i` with root key
- `i` = SHA-256 hash `i`
- Use `i` as raw ed25519 private key material

```ts
hash(sign(encode(name)));
```

## Browser Support

This design is bound by a complex support matrix of OS, browser, and
authenticator: [Device Support]

Additionally, the PRF extension **is not** currently supported in Firefox and
Safari **cross-device** auth (but is in other scenarios):

- [Firefox: Support WebAuthn PRF Extension](https://bugzilla.mozilla.org/show_bug.cgi?id=1863819)
- [Safari: PRF extension not supported in Safari's Cross-Device WebAuthn Flow](https://developer.apple.com/forums/thread/774112)

### Web Authn Support Matrix

Here are the triples (OS+browser+authenticator) we've tested this identity flow
on. Additionally, [passkeys.dev](https://passkeys.dev) maintains another
[Device Support] matrix. Currently focused on desktop browsers, though we will
want to support mobile auth as well.

| OS      | Browser | Authenticator | Status             | Notes                             |
| ------- | ------- | ------------- | ------------------ | --------------------------------- |
| Linux   | *       | 1Password     | :x:                | PRF not supported.                |
| Linux   | Chrome  | Yubikey       | :white_check_mark: |                                   |
| Linux   | Firefox | Yubikey       | :white_check_mark: | [Firefox 135+][bugzil.la/1935277] |
| MacOS   | *       | 1Password     | :x:                | PRF not supported.                |
| MacOS   | Chrome  | iCloud        | :white_check_mark: |                                   |
| MacOS   | Firefox | iCloud        | :question:         |                                   |
| MacOS   | Safari  | iCloud        | :question:         |                                   |
| MacOS   | Chrome  | Yubikey       | :question:         |                                   |
| MacOS   | Firefox | Yubikey       | :question:         |                                   |
| MacOS   | Safari  | Yubikey       | :question:         |                                   |
| Windows | *       | 1Password     | :x:                | PRF not supported.                |
| Windows | Chrome  | Windows Hello | :question:         |                                   |
| Windows | Edge    | Windows Hello | :question:         |                                   |
| Windows | Firefox | Windows Hello | :question:         |                                   |
| Windows | Chrome  | Yubikey       | :question:         |                                   |
| Windows | Edge    | Yubikey       | :question:         |                                   |
| Windows | Firefox | Yubikey       | :question:         | [Firefox 135+][bugzil.la/1935277] |

### Web Crypto Ed25519 Keys

Using the native [Web Crypto API] is preferred for security and distribution
reasons, and also it's a prerequisite to safely storing keys in IndexedDB in a
non-extractable form.
[Ed25519 keys are supported in Firefox and Safari](https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519),
though Chromium browsers require _Experimental Web Platform Features_ to be
enabled.

For unsupported browsers, we instead use the audited library, [@noble/ed25519].
The non-native keys are stored as buffers in IndexedDB and are **extractable**
:warning:.

In the future, we can explore upgrading a noble key to a native one when a noble
key is recovered in a browser (that now) supports native ed25519 keys.

| Browser | Supported?         | Notes                                              |
| ------- | ------------------ | -------------------------------------------------- |
| Firefox | :heavy_check_mark: | [Firefox 136+][bugzil.la/1939993]                  |
| Safari  | :white_check_mark: |                                                    |
| Chrome  | :heavy_check_mark: | Requires _Experimental Web Platform Features_ flag |

## Usage

See [`examples/index.html`](/identity/examples/index.html) of an example
authentication flow.

```js
import { PassKey, RootKey } from "@commonfabric/identity";

// First check if we've already stored a root key.
let rootKey = await RootKey.fromStorage();
if (rootKey) {
  setRootKey(rootKey);
}

// If no root key set, wait for user to authenticate a PassKey,
// either by creating a new one, or reauthenticating.
onRegister(async () => {
  // passkeys can store a "name" and "displayname" for use
  // with browser mediation UI.
  await PassKey.create("User Name", "displayname");
});

onLogin(async () => {
  // A passkey is already available on the device, fetch it
  // and derive a root key
  let passkey = await PassKey.get();
  let rootKey = await RootKey.fromPassKey(passkey);
  // Store the rootkey so that it can be recovered
  // via `RootKey.fromStorage()`.
  await rootKey.saveToStorage();
  setRootKey(rootKey);
});

function setRootKey(rootKey) {
  // start working with root key
}
```

## UX Considerations

- No Browser/authentication combinations allow sidestepping further verification
  on passkeys (e.g. fingerprint unlock) via the
  [`userVerification`](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions#userverification)
  option `"discouraged"`.
- WebAuthn PRF results are only available upon retrieving the passkey (e.g.
  `navigator.credentials.get()`), not upon creation
  (`navigator.credentials.create()`). This means, due to always requiring user
  verification, that creating a new key will then also require fetching the key
  (2 unlocks) in order to derive a `RootKey`.

## Security/Privacy Considerations

- :warning: This cryptography has not been audited.
- :warning: This solution is in development and will change.
- The WebAuthn passkey's PRF output should be considered a secret key, as the
  `RootKey` is derived from it, though
  [WebAuthn APIs are not isolated from local and extension scripts](https://levischuck.com/blog/2023-02-prf-webauthn#heading-conclusion).
- No key rotation support yet.

## Resources

- [Yubico Web Authn Playground](https://demo.yubico.com/webauthn-developers)
- Reset security keys via chrome `chrome://settings/securityKeys`
- [Device Support](https://passkeys.dev/device-support/)

[Web Crypto API]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
[Web Authentication API]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
[PRF extension]: https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension
[Device Support]: https://passkeys.dev/device-support/
[@noble/ed25519]: https://github.com/paulmillr/noble-ed25519
[bugzil.la/1935277]: https://bugzilla.mozilla.org/show_bug.cgi?id=1935277
[bugzil.la/1939993]: https://bugzilla.mozilla.org/show_bug.cgi?id=1939993
