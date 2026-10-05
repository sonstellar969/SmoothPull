# SmoothPull

SmoothPull is a Firefox WebExtension for macOS that adds a pull-to-refresh gesture for trackpads.

When a page is already at the top, a deliberate downward trackpad scroll displays a pull indicator. Pulling past the threshold changes the indicator to a release state. The tab reloads only when the gesture is released after the threshold has been crossed.

## Features

- Designed for Firefox on macOS.
- Uses normal trackpad wheel events and does not require a keyboard or mouse button.
- Activates only at the top of the page.
- Leaves ordinary scrolling unchanged away from the top.
- Avoids nested scrollable elements such as chat panels and code editors.
- Uses resistance and an eased indicator animation.
- Requires an intentional pull and release before reloading.
- Protects against single wheel events and trackpad momentum restarting the gesture.
- Works on ordinary websites without site-specific changes.

## Project layout

```text
SmoothPull/
├── README.md
└── smooth-pull/
    ├── manifest.json
    ├── content.js
    ├── background.js
    └── style.css
```

## Installation for development

1. Open Firefox.
2. Visit `about:debugging`.
3. Select **This Firefox**.
4. Select **Load Temporary Add-on**.
5. Choose `smooth-pull/manifest.json`.
6. Open or reload a webpage before testing.

Temporary extensions are removed when Firefox restarts. Reload the extension from `about:debugging` after changing its files, then reload the webpage.

## Usage

1. Scroll down a webpage.
2. Scroll back to the top normally.
3. Pause briefly after reaching the top.
4. Pull downward with two fingers on the trackpad.
5. Continue until the indicator reaches the release state.
6. Release the trackpad.

If the pull does not cross the threshold, the interaction is cancelled and the page is not reloaded.

## Permissions

The extension uses the following access:

- `<all_urls>` content-script matches: required because the gesture must work on normal webpages without modifying each website.
- `tabs`: used by the background script to reload the tab that originated the gesture.

SmoothPull does not send page contents, browsing history, gesture data, or personal information to a server.

## Configuration

Gesture constants are near the top of `smooth-pull/content.js`:

- `THRESHOLD_PX`: pull distance required to arm the refresh.
- `TOP_SETTLE_MS`: settling time required after returning to the top.
- `TOP_REARM_GAP_MS`: minimum gap separating normal scrolling from a new pull.
- `RELEASE_DELAY_MS`: delay used to detect the end of the pull.
- `MOMENTUM_COOLDOWN_MS`: protection against late inertial wheel events.
- `MAX_EVENT_DELTA_PX`: rejects unusually large wheel events.

Lowering `THRESHOLD_PX` makes the gesture more sensitive. Lowering the top-settle values makes it activate sooner but increases the chance that momentum will be interpreted as a pull.

## Debugging

For page-side behavior:

1. Open Firefox Developer Tools with `Cmd + Option + I`.
2. Select the **Console** tab.
3. Use the page inspector to search for `#ptr-indicator`.
4. Inspect the computed values of `--ptr-progress` and `--ptr-distance` while pulling.

For extension-side errors:

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Find **SmoothPull**.
4. Select **Inspect** to open the extension background context.
5. Check the Console for errors from `background.js`.

After editing files, reload the extension and reload the webpage. An already-open page may still contain the previous content-script instance.

## Technical limitation

Firefox does not expose a dependable count of fingers used for a macOS trackpad gesture. SmoothPull therefore cannot prove that an event came from exactly two fingers. It uses the available wheel-event data, direction, event size, timing, page position, nested-scroll checks, and momentum protection as a practical approximation.

Safari can implement this behavior in the browser's native scrolling and browser-chrome layers. A WebExtension can draw only inside the webpage and cannot reproduce Safari's native overscroll physics or toolbar indicator exactly. SmoothPull intentionally keeps the document stationary to avoid transforming arbitrary websites and causing layout or rendering problems.

## Development checks

Run these commands from the repository root:

```sh
node --check smooth-pull/content.js
node --check smooth-pull/background.js
python3 -m json.tool smooth-pull/manifest.json >/dev/null
```

## License

Choose and add a license before publishing. If no license file is present, all rights are reserved by default.
