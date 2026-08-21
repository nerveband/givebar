# Givebar Live Event & Broadcast Production UX Reference

A reference guide benchmarking Givebar against live production tools like Stagetimer.io and H2R Graphics (HereToRecord).

---

## 1. Production Tier Architecture & Mental Model

```
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Production Tier  | Stagetimer.io                    | H2R Graphics (heretorecord.com)  | Givebar Architecture               |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Output Display   | Viewer / Output Link             | Program Output / Lower Thirds    | Main Ballroom Screen (/stage)      |
|                  | Fullscreen projection, clean feed| NDI / Web Overlay / Transparent  | Clean 1080p HUD, 130px Odometer    |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Director Console | Controller / Operator Room       | Rundown & Control Deck           | Event Control Room (/control)      |
|                  | Transport controls (Start/Pause) | Cues, On-Air toggles, "Hide All" | Live Staging Tally, 8s Delay, Hold |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Talent Monitor   | Moderator / Agenda               | Speaker View / Prompter HUD      | Podium Screen (/emcee)             |
|                  | Message overlays & countdown     | Live tally & dynamic variables   | OLED Contrast, 3s Glance Shoutouts |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Floor Entry      | Remote Trigger / Web Form        | Variable Web Form                | Volunteer Pledge Pad (/entry)      |
|                  | Mobile trigger URL               | Data collection form             | 1-Thumb Numpad, Ask Presets, Undo  |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Emergency Safety | Blackout Screen / Red Flash      | Global "Hide All" / Panic Cut    | Pause Ballroom Screen / Blackout   |
+------------------+----------------------------------+----------------------------------+------------------------------------+
| Live Staging     | Staged Cue -> Activated Cue      | Preview -> Program (On-Air)      | 8s Review Queue -> Live On Screen  |
+------------------+----------------------------------+----------------------------------+------------------------------------+
```

---

## 2. Ultra-Plain Everyday Terminology Guide

| Technical / Internal Jargon | Standard Event Term | Ultra-Plain Everyday Term (Givebar UI) |
| :--- | :--- | :--- |
| `Stage 1080p HUD` | Program Projection Output | **Main Ballroom Screen** (`/stage`) |
| `AV & Admin Control Deck` | Master Controller / Rundown | **Event Control Room** (`/control`) |
| `Emcee Confidence Monitor` | Speaker Prompt / Podium HUD | **Podium Screen** (`/emcee`) |
| `Volunteer Entry Terminal` | Mobile Pledge Client | **Volunteer Pledge Pad** (`/entry`) |
| `Decoupled Display Buffer` | Broadcast Delay Staging | **8-Second Review (Catch Typos)** |
| `YANK` | Revoke Chyron / Hold | **Hold from Stage** (Red Action Button) |
| `Append-Only Event Ledger` | Audit Event Stream | **Verified Donation List** |
| `Folded Ledger Total` | Authoritative Balance | **Total Raised** |
| `Monotonic Sequence Polling` | State Sync | **Live Connected** (● Green Indicator) |
| `Card Serial Collision` | Duplicate Card Check | **Duplicate Card Number** |
| `No-Backward-Odometer Rule` | Floor Monotonicity | **Keep Screen Moving Forward** (No Rollbacks) |
| `Manual Override Cents` | Display Offset Delta | **Adjust Ballroom Screen Total** |
| `Clerk Identifier` | Operator ID | **Volunteer Name** |
| `Confetti Trigger` | Celebration Cue | **Launch Stage Confetti** |
| `Emergency Freeze` | Blackout / Slate | **Pause Ballroom Screen** |

---

## 3. Zero-Code In-App Customization Specification

The Event Control Room (`/control`) includes an in-app **Event Settings** tab where event directors can customize:
1. **Event Identity**: Event title, subtitle, organization, and QR code donation URL.
2. **Fundraising Target**: Goal target dollars, milestone percentage pips (25%, 50%, 75%), and auto-confetti celebration triggers.
3. **Brand & Color Theme**: Visual swatches (Champagne Gold, Royal Sapphire, Emerald Green, or custom HEX) that update the stage accent and progress bar in real time.
4. **Volunteer Quick-Amounts**: Configurable ask-tier buttons ($10k, $5k, $2.5k, $1k, $500, or custom presets).
5. **Matching Donor Setup**: Sponsor title, matching grant pool amount, match ratio (1:1 double, 2:1 triple), and live active toggle.
6. **Passcode Protection**: Optional PINs for Control Room and Volunteer Pads.
