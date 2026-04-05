# Project Context: JM Tennis App (jmtennisappv1)

This document provides a comprehensive overview of the JM Tennis App project, its architecture, data structures, and core logic. It serves as both a developer onboarding guide and a context file for AI assistants.

> Extension deep-dive: For full Chrome extension architecture, runtime flow, scraping/auth SOP, and structural risk notes, read [`extensionlogic.md`](extensionlogic.md).
> Club mode source of truth: For club/team/league scraping and persistence details, read [`clublogic.md`](clublogic.md).

## 🎾 Project Vision
A mobile application designed specifically for the German tennis community. It provides players with high-quality statistics, player tracking (following), and tournament discovery. The primary challenge is the lack of an official API from `tennis.de`, which is solved through a custom Chrome extension scraper.

---

## 🛠 Tech Stack
- **Mobile App**: Expo (React Native) with TypeScript.
- **Backend/Database**: Supabase (PostgreSQL, Auth, Storage).
- **Data Acquisition**: Chrome Extension (`tennisdescraper`) built with Vanilla JavaScript and Supabase JS SDK.
- **Styling**: Nativewind (Tailwind CSS for React Native).

---

## 📁 Project Structure

```text
.
├── android/                 # Android native project files
├── app/                     # Main Expo Router application
│   ├── (auth)/              # Authentication screens (Login, Register)
│   ├── (tabs)/              # Main tab-based navigation (Home, Search, Profile)
│   ├── profile/             # Profile detail screens ([user_id].tsx)
│   ├── tournament/          # Tournament details and category views
│   ├── match-history/       # Historical match data by DTB-ID
│   └── _layout.tsx          # Root app layout and providers
├── assets/                  # App assets (Images, Fonts)
├── components/              # Shared UI components (Charts, Cards)
├── contexts/                # React state contexts (Auth, Theme)
├── hooks/                   # Custom hooks (Framework, status bar)
├── ios/                     # iOS native project files
├── lib/                     # Libraries & Helpers (Supabase)
├── supabaseschema/          # Database definitions (SQL)
├── tennisdescraper/         # Chrome extension for scraping
│   ├── icons/               # Extension icons
│   ├── utils/               # Scraper utility functions
│   ├── content.js           # Main scraper logic
│   ├── tournament-content.js# Tournament scraping logic
│   ├── manifest.json        # Extension manifest
│   └── background.js        # Extension background worker
└── utils/                   # Shared app utilities
```

---

## 📊 Database & Data Model
The database is hosted on Supabase. Data integrity is paramount, especially regarding match uniqueness.

### Core Tables
| Table | Description | Key Unique Constraint |
| :--- | :--- | :--- |
| `players` | Registry of all scraped tennis players. | `dtb_id` |
| `matches_v2` | All recorded tennis matches (canonical). | `match_fingerprint` |
| `profiles` | App user profiles (linked to Supabase Auth). | `id`, `username` |
| `player_user_links` | Links an app user to a specific `dtb_id`. | `user_id`, `dtb_id` (1:1) |
| `follows` | Social Graph: User following a Player. | `follower_id`, `target_dtb_id` |
| `tournaments` | Metadata for tennis tournaments. | `event_id` |
| `club_player_rankings` | Team-portrait ranking context linked to players. | `club_id, season_year, season_type, observed_source_team_id, observed_player_name` |

### Match Uniqueness (`match_fingerprint`)
To prevent duplicate matches when scraping from different perspectives (e.g., Player A's profile vs Player B's profile), a canonical **match fingerprint** is generated:
1. **Team Sorting**: Players within a team are sorted alphabetically; Teams themselves are sorted alphabetically.
2. **Score Normalization**: If teams were swapped during sorting, the score is automatically flipped (e.g., `6:4` becomes `4:6`).
3. **Hash Components**: `team1 | team2 | date | event | normalizedScore`.
4. **Implementation**: Found in `tennisdescraper/content.js` -> `generateUniversalMatchHash()`, persisted in `matches_v2.match_fingerprint`.

---

## 🕷 Scraping Logic (`tennisdescraper`)
The scraper is the heart of the data pipeline. It runs as a sidepanel or content script on `tennis.de`.

For current extension behavior and maintenance workflow, use [`extensionlogic.md`](extensionlogic.md) as the primary source of truth.

### Key Features:
- **Live Scrape**: Triggered while browsing player profiles or tournament pages.
- **Sync Match History**: Automatically paginates and scrapes the full history of a player.
- **Profile Verification**: Detects the "Accounteinstellungen ändern" button on `tennis.de` to verify that the logged-in user is the owner of the profile they are currently viewing.
- **Tournament Mode** (`tournament-content.js`): 
    - **Registration Tracking**: Scrapes Zulassungsliste (entry lists) including categories, player names, DTB-IDs, and seeding status.
    - **Location Discovery**: Automatically clicks "Platzanlage" buttons to reveal tournament addresses and generates Google Maps links.
    - **Classification Detection**: Uses SVG image detection to classify tournaments as "DTB" or "LK" branded events.

---

## 🔐 Profile Linking & Verification
Users can link their app account to a DTB player profile.
1. **Linking**: Stores the mapping in `player_user_links`.
2. **Verification**: When the user visits their own profile on `tennis.de` while using the extension, the extension detects ownership and updates the `verified` status in Supabase.
3. **Benefits**: Verified users get special badges.

---

## 📝 Important Developer Notes
- **LK Values**: "Leistungsklasse" (LK) is a German rating system. Values range from 1.0 to 25.0. In the database, they are stored as `numeric(4, 1)`.
- **Canonical Player Table**: Use `players` as the single source for player search and identity. Team portrait scraping enriches `players` asynchronously via `dtb_id`.
- **Club Field Normalization**: `players.club` stores display names without trailing club code suffixes (e.g. `Münchner Sportclub`, not `Münchner Sportclub (01038)`), while `main_club_id` stores canonical club linkage.
- **Ranking Context**: `club_player_rankings` is context/provenance for club/team/season ranking snapshots and links back to canonical players through `player_id` when available.
- **Date Formats**: Scraper handles German format (`DD.MM.YYYY`) and converts it to ISO (`YYYY-MM-DD`) for storage.
- **No API**: Always check the scraper logic if data structure changes are needed; the app is purely a consumer of the Supabase data populated by the scraper.
- **Internal Name**: The project is internally named `jmtennisappv1`.
