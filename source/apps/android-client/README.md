# Android client contract

The Android client keeps the native renderer in a WebView and uses a versioned, credential-free UI cache for startup and offline rendering.

The release manifest must contain an immutable version, a shell path, exact byte counts, lowercase SHA-256 values, and safe MIME types. The client activates a staged release only after every file verifies successfully; the previous release remains available as `lastgood`.

The WebView bridge is same-origin and top-frame-only. It exposes status, read-only cache reads, and explicit user-controlled sync start/stop. It does not carry cookies, provider tokens, account credentials, message bodies, or execution requests.

Replace the placeholder origin, package signing, notification policy, and foreground-service policy with values appropriate to your deployment.
