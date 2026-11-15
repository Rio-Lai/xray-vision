# How we used Figma

A short, true account for the submission and for the video's Figma beat (#26). Everything below happened on Saturday 14 November 2026, the day before submission.

## 1. The concept prototype (Figma Make, earlier today)

We used Figma Make to prototype the wider vision of Blowfish as a first-person story, separately from the app's code.

- **First version** ("X-Ray Vision — concept prototype"): https://www.figma.com/make/HAhTA2BU8IjzSlJ2nyjvuK/ . It came out as a dark sci-fi HUD (panels, cyan lines, monospace). Rio rejected it as "too Tony Stark".
- **Second version** ("Blowfish — concept prototype"): https://www.figma.com/make/vIDcMqov0Y85Ru6h4mlbUe/ . A nine-step, first-person voice story in calm frosted glass: the camera image stays the hero, with small frosted pills, one card per part and a voice pill with captions.

The prototype is a picture of the vision, not the app. The app was coded in parallel (Vite, React, three.js) and follows the same written design language (`docs/PROJECT.md` section 2), so the two look alike; the prototype's code was not used in the app.

## 2. The interface kit (Figma Make, tonight)

- **File:** "Blowfish — interface kit": https://www.figma.com/make/ELqI9Zkp1eBvkYn7hOwlIR/ , started at about 22:20 GMT.
- **What it is:** everything the wearer sees on top of the camera image, built in Figma Make as a small component kit (plain React plus CSS variables, no Tailwind, no icon or font packages) and shown on one page: the glasses view at 16:9 with a switcher for nine states (clean view, overlay on, looking, model on stage, part selected, step card, hand and arm, voice pill states with captions, error), plus a components sheet and a token sheet.
- **How it was made:** five prompts between about 22:20 and 22:47: a first build from a written brief (states, content from our checked parts lists, design rules from `docs/PROJECT.md` section 2, and the code shape), then review rounds. Each round we looked at every state, including crops at true 1080p size, and asked Make for specific fixes: a backdrop photo without brand logos, leader lines that do not cross or run under labels, a stronger dimming behind the model, readable captions over a bright desk, a more natural hand, a components sheet and a tokens sheet, and corrected label positions.
- **Where the code is:** the kit's files are in [`docs/design/make-interface-kit/`](make-interface-kit/) exactly as Make produced them (checked byte for byte), with three screenshots and a README (components, states, tokens, and what changed compared with the app's earlier look). The kit is **being moved into the app (issue #86)**; until that merges, the app still runs on its own stylesheet (`src/hud/styles.ts`, `src/voice/voiceStyles.ts`).

What this kit changed is the polish and consistency of the overlay, not the product's direction: the calm frosted-glass direction, the colours and the minimum type sizes were already set in `docs/PROJECT.md` section 2 before the kit was made.

## 3. Suggested Figma beat for the video (about 10 seconds)

Storyboard row F in `docs/pitch/video.md` (1:46 to 1:55). Screen-record Figma with the Figma UI and the file names visible.

1. **1.5 s:** the first prototype (dark HUD), tag "First prototype, rejected".
2. **3 s:** "Blowfish — interface kit" in Figma Make: click through the state switcher (overlay on, model on stage, part selected), tag "Figma Make".
3. **2 s:** the kit's components and tokens sheet, scrolling.
4. **2.5 s:** the same part card and voice pill in the app (screen recording), side by side with the kit. Use this only once #86 is merged and the app really uses the kit; until then, show the concept prototype instead (as in the current storyboard).

Suggested voice-over, if #86 is merged: "We designed the interface in Figma Make, threw out our first sci-fi HUD, and moved the kit's code straight into the app." If #86 is not merged, keep the current line from `docs/pitch/video.md`.
