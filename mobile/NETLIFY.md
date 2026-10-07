# Netlify deployment modes

Adding a computer to an existing Netlify-backed Hub only requires [Connector enrollment](README.md). It does not require a new site, deployment or cloud-state initialization.

## Existing Functions Hub

`netlify-hub.mjs` builds the PWA and Functions runtime for an existing owned site. State lives in site-wide Blobs. The runtime checks the exact site/origin and published production deployment, uses conditional writes, and excludes private management routes.

```sh
node mobile/netlify-hub.mjs output/mobile-cloud https://your-site.netlify.app 11111111-2222-3333-4444-555555555555
npm ci --ignore-scripts --prefix output/mobile-cloud
```

Replace the example origin and site UUID. Authenticate with the provider's CLI, then deploy from the generated directory using `public` as the public directory and `functions` as the function directory. Never upload the repository, `.pi`, authentication caches, deployment receipts or device configuration.

The builder produces **code only**. It does not provision/reset Blobs, create identities or set a password. Preserve an existing site's private state. A fresh Functions installation requires separate operator provisioning; this is not a one-command initializer. For an independently initialized new Hub, use `hub-init` from the main guide.

Optional password login stores a scrypt verifier server-side, not a universal password in the PWA. Roll back code through the provider without overwriting identities, and allow only the published deployment to access production state.

## Static frontend and separate Hub

An alternative uses Netlify as a signed same-origin API proxy to a separate HTTPS Hub:

```sh
node mobile/netlify.mjs prepare output/mobile-proxy --hub https://hub.example.com
```

Configure matching private proxy signing secrets on the Hub and Netlify runtime, and an exact browser origin. Secrets must not appear in TOML, JavaScript or command arguments. Proxy only the browser API; keep management private and connect factory Connectors directly to the Hub.

Without `--hub`, the builder makes a frontend-only preview that explicitly refuses business actions. A static page loading does not prove the factory is connected.

## Verify

```sh
node mobile/netlify.mjs verify https://your-site.netlify.app
```

Check HTTPS, CSP, no-store and the expected unauthenticated API response, then authorized device selection, conversations, receipts and revocation. Polling, platform quotas, computer sleep and browser background suspension remain limits. A desktop viewport test is not a real phone/network acceptance test.
