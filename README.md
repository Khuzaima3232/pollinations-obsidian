# Pollinations for Obsidian

Generate text and images with Pollinations inside your notes, paying with your
own Pollen. Text lands at the cursor; images are saved into the vault and embedded
in the note.

## Install

Until this is in the community directory, install it manually:

1. Download `main.js`, `manifest.json` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/pollinations/`.
3. Enable **Pollinations** in **Settings → Community plugins**.

Requires Obsidian 1.4.0 or newer. Works on desktop and mobile.

## Connect your account

No API key is pasted anywhere. Choose **Connect account** from the command
palette: the plugin shows a short code, opens the approval page, and waits for you
to approve. The page shows which account, the budget and the expiry. Approval can
be declined from the browser and the plugin stops.

The authorization is a scoped `sk_` token stored in the plugin's own folder, not
in `data.json`, so it is not carried around if you sync or share your vault. It is
only ever sent as a bearer header to Pollinations. Response bodies are never shown
in notifications, because an error body can echo the credential.

## Commands

| Command | What it does |
| --- | --- |
| Connect account | Device-flow sign-in |
| Disconnect account | Removes the local authorization |
| Generate text from prompt | Writes the model's reply at the cursor |
| Generate text from selection | Uses the selection as the prompt |
| Generate image | Saves a generated image into the vault and embeds it |
| Edit image under cursor | Edits the open image with an image model |

Settings hold the text model, image model, optional resolution, the vault folder
for images, and an optional publishable `pk_` key so usage is attributed to this
plugin as an app.

## Verification

```sh
npm install
npm run build     # tsc --noEmit && esbuild
npm test          # vitest run
```

The suite stands a real HTTP server on localhost in front of the transport, so
requests genuinely go over the wire and responses are genuinely parsed, but no
external credentials are used and no Pollen is spent. It covers the device flow
(pending, `slow_down`, cancelled, declined), error-to-sentence mapping, the
guarantee that a response body never reaches an error message, catalog filtering,
base64 image decoding, and the edit path.

## Honest gaps

- Live billed generation and a real device-flow approval were not run as part of
  the automated tests — those need a signed-in account and spend Pollen.
- Only the text and image catalogues are used for their respective commands;
  audio and video models are deliberately out of scope.
- Linux and macOS are not separately tested; the transport is Obsidian's
  `requestUrl`, which is platform-independent, and the plugin is marked as not
  desktop-only so mobile is expected to work.

## Contracts

- [BYOP device flow](https://github.com/pollinations/pollinations/blob/main/BRING_YOUR_OWN_POLLEN.md)
- [API docs](https://gen.pollinations.ai/docs), image and text model lists
- [Obsidian plugin docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
