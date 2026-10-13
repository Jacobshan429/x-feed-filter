# x-feed-filter

Userscript that uses Jev to hide noise and slop on the X timeline.

Each post on your home and list timelines is sent to [TypeSafe's Jev](https://docs.typesafe.ai) with one question: is it `signal`, `bait`, `slop` or `promo`?
A post whose noise label scores at least 0.70 collapses to a one-line stub (`Hidden - slop 0.82 - show`) that you can tap to read it.
Every other post gets a small label chip (`signal 0.93`), so wrong calls are easy to spot. Nothing is ever removed.

It is one file, `x-feed-filter.user.js`, with no build step and no dependencies.
Profiles, opened conversations and every other page are left alone.

## Install

Desktop (Chrome, Firefox, Edge or Safari):

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
   In Chrome, also turn on "Allow user scripts" for the extension in `chrome://extensions`.
2. Open https://raw.githubusercontent.com/Jacobshan429/x-feed-filter/main/x-feed-filter.user.js and confirm the install.

iPhone (Safari):

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) from the App Store and open it once.
2. Turn on Userscripts in Safari's extension settings (the `AA` button in Safari, or Safari > Extensions in the Settings app) and allow it on `x.com`.
3. Open the raw URL above in Safari, open the Userscripts extension popup, and accept the install prompt.

Updates install automatically from the same URL.

## API key

1. Create a dedicated key in the [TypeSafe console](https://console.typesafe.ai/keys) so you can revoke it on its own.
2. Open x.com, tap the blue `Jev: add key` pill in the bottom left corner, paste the key, and tap Save.

Do this once per device. The key is kept in the userscript manager's storage, never in the script, and is only sent to `api.typesafe.ai`.
The script runs isolated from the page, and the settings panel lives in a closed shadow root, so x.com's own scripts cannot read the key.

Cost is about US$0.04 per 1,000 posts labelled (roughly 1,000 input tokens per post at US$0.042 per million).
Labels are cached for the latest 2,000 posts, so scrolling back or reloading costs nothing.

## Using it

The pill shows what the filter is doing and opens the settings when tapped:

| Pill | Meaning |
| - | - |
| `Jev on - 120 labelled, 14 hidden` | Filtering this page |
| `Jev: add key - 12 posts` | No key yet; nothing is filtered |
| `Jev idle on this page` | Not a home or list timeline |
| `Jev: key rejected` (red) | The key was refused; nothing is filtered until you save a new one |
| `Jev error - unfiltered` (red) | Three requests failed in a row; nothing is filtered for 60 seconds |

New posts blur for a moment while they are labelled. A post never stays blurred more than 6 seconds; if Jev has not answered by then it shows with an `unlabelled` chip.

Settings:

1. **Hide threshold** (default 0.70). Raising it hides less. Changing it re-applies cached labels at once, with no new requests.
2. **Hide these labels.** Untick a label to show its posts with a chip instead of a stub.
3. **Definitions** for each label. Editing one re-labels posts as you next see them. Put exact boundary cases into the definition, for example "official product announcements count as signal". Clear a box to restore its default.
4. **Model**, pinned to `jev-1.13.0`. Change it deliberately; it re-labels everything.
5. **Filter every page (testing)** also filters profiles and conversations.

The panel also shows how many API requests this page load has made and how many posts are cached.

Known limits: images and video are not judged (Jev reads text only, and media-only posts are left alone), accuracy is weaker outside English, and a post written to steer the model can move its answer. The worst case is a slop post shown.

## End-to-end checklist

Run this after installing or changing the script. There are no unit tests; this list is the test plan.

1. Install on desktop Violentmonkey or Tampermonkey with no key. Open your home timeline: the pill shows, nothing is blurred, and the pill's post count is above zero (this confirms the script reads your timeline's layout).
2. Add the key: posts blur and resolve in about 1 second, each with a chip or a stub.
3. Scroll about 200 posts: none stays blurred, and the hidden count matches the stubs you passed.
4. Reload: labels appear from cache, and the panel's request count stays at 0 for posts already seen.
5. Save a wrong key and edit a definition so posts need new labels: everything is unfiltered within 6 seconds and the pill turns red with `key rejected`. Save the right key again, then cut the network (turn off Wi-Fi) and edit a definition again: everything is unfiltered within 6 seconds and the pill turns red with `Jev error - unfiltered`. (DevTools request blocking on the x.com tab does not catch these requests, because the userscript manager sends them.)
6. Edit a definition: posts re-label as you see them and the request count rises. Change the threshold: stubs and chips update at once and the request count does not move.
7. Repeat steps 1 to 4 on iPhone Safari with the Userscripts app.
8. Count wrong labels among the first 50 posts as a tuning baseline.

## License

MIT
