# Android source build

The Android client now carries the maintained local SQLite archive, current/pinned/recent read priority, independent network pools, scoped drafts and pending messages, completion/background policies, and bounded diagnostic outbox. Its application ID is `org.bettercodex.android`, separate from the author's private application. It targets Android 8 or newer.

The repository does **not** redistribute official renderer files, production APKs or signing keys. Build an origin-pinned client for your own deployment; an APK built for somebody else's origin cannot safely be reused. The initial supported pairing target is your Mac's HTTPS Tailscale Serve origin. The Web/PWA CVM access path remains available; Android HTTP Basic credential handoff and physical-device Tailscale pairing have not been accepted in this release.

1. Install and start the [portable Mac host](open-source-setup.md). For phone use configure Tailscale Serve before building. Install JDK 17, Android SDK 36 and Gradle 9.6.
2. Generate a credential-free UI package from your own host's `native.webOrigin`. Set `WORKBENCH_CONFIG` to your generated `deployment.json`; the example port below follows the default installer.

```sh
WORKBENCH_CONFIG="$HOME/.better-codex/deployment.json" \
  node scripts/package-android-ui.mjs \
  --upstream http://127.0.0.1:4174 \
  --out "$HOME/.better-codex/android-ui"
```

3. Build with the exact HTTPS origin approved in your deployment configuration. Origins must be bare HTTPS domains on port 443, with no embedded credentials, path, query or fragment. The authentication origin defaults to the same origin. Never commit the generated bundle or your signing material.

```sh
cd source/apps/android-client
ANDROID_HOME="$ANDROID_HOME" gradle \
  -PworkbenchOrigin=https://your-machine.your-tailnet.ts.net \
  -PandroidUiDir="$HOME/.better-codex/android-ui" \
  :app:testDebugUnitTest :app:assembleRelease
```

The release task produces an unsigned APK in `app/build/outputs/apk/release/`. Sign it with your own Android key using `zipalign` and `apksigner`, then install it. Keep that key for future updates. The generated UI is hash-verified before activation, persists between launches, and has no conversation or authentication content.

`workbench.example.test` is a non-routable build/test default. It is not a deployed service. A release must supply `workbenchOrigin` and `androidUiDir`; the public build script rejects missing values. Java/WebView network tests use isolated local fixtures; they do not prove real account, VPN, background or battery behavior. See [validation](portable-validation.md) for the exact accepted boundaries.

Authentication is still checked on every request by the portable entry. In Tailscale mode an authenticated response may set a cache-unlock hint cookie; the server never accepts that hint as authentication. No origin or credentials can be changed through an untrusted WebView message. SMS and background permissions remain opt-in platform flows, and no private SMS pairing service is deployed by this repository.
