# CarPlay research (no purchase, nothing built for the car)

Researched 2026-10-15 from web sources. **Confidence is marked on each finding.** Several pages could not be fetched (Apple's entitlement page came back empty, MacRumors was unreachable), so anything resting on news coverage rather than Apple's own pages is labelled that way. Nothing here has been tried in your Velar.

## What I found
1. **Apple opened CarPlay to voice AI apps in iOS 26.4** (news coverage: [MacRumors](https://www.macrumors.com/2026/02/18/ios-26-4-carplay-support/), [TechRadar](https://www.techradar.com/vehicle-tech/car-infotainment/apple-carplay-gets-a-big-ai-upgrade-in-ios-26-4-that-lets-you-talk-to-chatgpt-gemini-and-claude-but-theres-a-catch), [Digital Trends](https://www.digitaltrends.com/cars/youll-soon-be-able-to-use-chatgpt-gemini-and-claude-in-apple-carplay/)). *Medium-high confidence.* It is a new app category, "voice-based conversational", with its own entitlement (`com.apple.developer.carplay-voice-based-conversation`, per [Gadget Hacks](https://apple.gadgethacks.com/news/chatgpt-carplay-ios-264-support-explained-no-apps-yet/); not confirmed on Apple's page).
2. **The rules, per the same coverage:** voice must be the main way to interact; a visual voice-control screen is required; the app should **not show text or images** in answers; **no wake word** (you must start the app with a touch); it cannot control the car or the iPhone; and **Siri stays the default assistant**. *Medium confidence.*
3. **Approval is Apple's call.** Apple's own [entitlement page](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements) says you request the entitlement for your app's category, accept an addendum, and Apple reviews against set criteria. *Medium confidence for the process; I could not read whether a personal, single-user app qualifies, and I would not assume it does.*
4. **ChatGPT shipped CarPlay voice on 2026-03-31** ([MacRumors](https://www.macrumors.com/2026/03/31/openai-chatgpt-carplay/)). A Claude iOS CarPlay integration is reported ([Digital Trends](https://www.digitaltrends.com/cars/youll-soon-be-able-to-use-chatgpt-gemini-and-claude-in-apple-carplay/)) but I found no dated, reliable confirmation. *Low confidence on Claude.* Either way, those apps talk to their own services, **not to Jarvis, so they would not know your calendar, tasks or memory.**
5. **Velar:** an aftermarket vendor lists the Velar as supporting wired CarPlay with the steering-wheel voice button starting Siri ([Ottocast](https://www.ottocast.com/blogs/carplay-adapter/carplay-in-range-rover-elevating-your-drive-with-high-tech-connectivity)). That is a vendor page, generic, not specific to your 2020 Touch Pro Duo. *Low confidence: confirm in your car and owner's manual.*
6. **Android "AI boxes" (the other idea):** the one detailed 2026 review found the steering-wheel voice button **only launches the box's own AI prompt and can't be remapped**, the OS can freeze until the car is restarted, boot and connection are slow, and the AI features need a paid data/token plan ([Gear Diary](https://geardiary.com/2026/07/08/ottocast-ottoaibox-p3-pro-review/)). The vendor says steering buttons, mic and speakers work fine, which that review contradicts. *Medium confidence it is more fragile and more expensive than it looks.* I found nothing reliable on true auto-launch at ignition or on the factory mic path.
7. **Siri Shortcuts / App Intents in CarPlay:** Apple Developer Forum replies are mixed: an older Apple engineer reply said CarPlay didn't support App Intents and pointed to voice Shortcuts as the workaround; a newer reply says intents using app schemas can run without opening the app; one developer reports Siri routing a third-party request to Apple Maps instead ([forum thread](https://developer.apple.com/forums/thread/831705)). *Low confidence. This is the one to test rather than trust.*

## Your options, ranked
| | What it is | Cost | Gets you | Main risks |
|---|---|---|---|---|
| **C. Siri Shortcut** (try first) | A Shortcut on your iPhone, "Ask Jarvis": asks what to say, sends it to Jarvis's device chat, speaks the reply. Start it with the steering-wheel button + "Ask Jarvis" | $0 plus normal model use | Voice conversation with Jarvis that knows your day, through the **car you already have** | Unknown whether Siri runs it cleanly in CarPlay; one request/answer at a time; no display; Jarvis must be reachable from the phone (Tailscale) |
| **A. Real Jarvis iPhone app in CarPlay** | A small native app using Apple's voice-conversational category | Apple developer account **$99/year**, plus Xcode work on your Mac, plus voice costs | A proper CarPlay screen with the Jarvis core animation and a real conversation | Apple must approve the entitlement (not guaranteed for a personal app); I can write the code but can't build or sign it from here; no wake word, you tap to open; no text/images allowed |
| **D. Android AI box** | Third-party box between the phone and the car screen | roughly the box price plus data plan (prices unverified) | Possible full custom screen | Steering button likely stays with the box's assistant; freezes/slow boot; warranty/insurance questions; I found nothing reliable on auto-start or mic; **do not buy before C and A are ruled out** |
| Web app in CarPlay | Not possible: CarPlay has no browser | n/a | n/a | (known limitation; I did not find a source this session) |

## Recommendation
1. **Do C first** once Jarvis can be reached over Tailscale from your phone (it works against your Mac at home too, as long as the Mac is on and has Tailscale; the server move makes it always-on). It costs nothing and answers the real question: *does voice-from-the-wheel work with the car I have?* Recipe below.
2. If C works but you want the animated screen, **then** decide on A (the $99 and Apple's approval are the gates). If Apple's approval looks unlikely, C is already most of the value.
3. Leave D until C and A are ruled out.

### Shortcut recipe (full, step-by-step version: **docs/CARPLAY_SHORTCUT.md**)
On the iPhone, Shortcuts app → New Shortcut named **Ask Jarvis**:
1. *Dictate Text* (or *Ask for Input*, type Text).
2. *Get Contents of URL*: `https://<your-jarvis-address>/api/device/chat`, method **POST**, header `Authorization: Bearer <a device key>`, header `Content-Type: application/json`, JSON body `{"text": <Dictated Text>, "mode": "driving"}`.
3. *Get Dictionary Value* for `speak`, then *Speak Text*.
Make a **car** device in Settings → Devices with a small monthly limit (say $3) for it. It can only chat and hear the greeting; it can never approve anything. A lost phone can be cut off by removing that device.

## What I need from you to go further
- Your iPhone model and iOS version (iOS 26.4+ matters for option A).
- Does wired CarPlay work in the Velar today, and does holding the steering-wheel voice button start Siri? (Two-minute check in the car.)
- Whether the $99/year Apple developer account is acceptable if we get to option A.

## Update: what Luke told me (2026-10-15)
- iPhone 17 Pro Max (has the Action Button). Wired CarPlay only. Not sure the steering-wheel voice button starts Siri (to be checked in the car).
- **Option C is not an app**: it is a Shortcut inside Apple's built-in Shortcuts app, nothing to install or sign. **Option A is a real app** (Xcode, $99/year, Apple approval).
- If the steering-wheel button doesn't start Siri, the Shortcut can be started other ways: say "Hey Siri, Ask Jarvis" (if "Hey Siri" works in CarPlay, to be checked), press the Siri/voice control on the CarPlay screen, or assign the **Action Button** on the phone to run it. The steering-wheel button is a nice-to-have, not required.
